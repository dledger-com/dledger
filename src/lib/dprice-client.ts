export interface DpriceHealthResponse {
  assets: number;
  prices: number;
}

export interface DpriceRateEntry {
  from: string;
  to: string;
  rate: string;
}

export interface DpricePriceEntry {
  date: string;
  price_usd: string;
}

export interface DpriceClient {
  health(): Promise<DpriceHealthResponse>;
  getRate(from: string, to: string, date?: string): Promise<string | null>;
  getRates(currencies: string[], date?: string): Promise<DpriceRateEntry[]>;
  getPriceRange(symbol: string, fromDate: string, toDate: string): Promise<DpricePriceEntry[]>;
  sync(): Promise<string>;
  syncLatest(): Promise<string>;
  latestDate(): Promise<string | null>;
  ensurePrices(requests: Array<{ symbol: string; date: string }>): Promise<string[]>;
  exportDb(): Promise<Uint8Array>;
  importDb(data: Uint8Array): Promise<string>;
}

class TauriDpriceClient implements DpriceClient {
  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  async health(): Promise<DpriceHealthResponse> {
    return this.invoke("dprice_health");
  }

  async getRate(from: string, to: string, date?: string): Promise<string | null> {
    return this.invoke("dprice_get_rate", { from, to, date });
  }

  async getRates(currencies: string[], date?: string): Promise<DpriceRateEntry[]> {
    return this.invoke("dprice_get_rates", { currencies, date });
  }

  async getPriceRange(symbol: string, fromDate: string, toDate: string): Promise<DpricePriceEntry[]> {
    return this.invoke("dprice_get_price_range", { symbol, fromDate, toDate });
  }

  async sync(): Promise<string> {
    return this.invoke("dprice_sync");
  }

  async syncLatest(): Promise<string> {
    return this.invoke("dprice_sync_latest");
  }

  async latestDate(): Promise<string | null> {
    return this.invoke("dprice_latest_date");
  }

  async ensurePrices(requests: Array<{ symbol: string; date: string }>): Promise<string[]> {
    const tuples = requests.map((r) => [r.symbol, r.date]);
    return this.invoke("dprice_ensure_prices", { requests: tuples });
  }

  async exportDb(): Promise<Uint8Array> {
    const data = await this.invoke<number[]>("dprice_export_db");
    return new Uint8Array(data);
  }

  async importDb(data: Uint8Array): Promise<string> {
    return this.invoke("dprice_import_db", { data: Array.from(data) });
  }
}

class HttpDpriceClient implements DpriceClient {
  constructor(private baseUrl: string) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`);
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`dprice HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async health(): Promise<DpriceHealthResponse> {
    return this.fetchJson("/api/v1/health");
  }

  async getRate(from: string, to: string, date?: string): Promise<string | null> {
    const params = new URLSearchParams({ from, to });
    if (date) params.set("date", date);
    try {
      const resp = await this.fetchJson<{ rate: string }>(`/api/v1/rate?${params}`);
      return resp.rate;
    } catch {
      return null;
    }
  }

  async getRates(currencies: string[], date?: string): Promise<DpriceRateEntry[]> {
    const params = new URLSearchParams({ currencies: currencies.join(",") });
    if (date) params.set("date", date);
    const resp = await this.fetchJson<{ rates: DpriceRateEntry[] }>(`/api/v1/rates?${params}`);
    return resp.rates;
  }

  async getPriceRange(symbol: string, fromDate: string, toDate: string): Promise<DpricePriceEntry[]> {
    // HTTP mode uses GraphQL for price range (REST has no range endpoint)
    const query = `{ priceHistory(symbol: "${symbol}", from: "${fromDate}", to: "${toDate}") { date priceUsd } }`;
    const resp = await fetch(`${this.baseUrl}/api/v1/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) {
      throw new Error(`dprice GraphQL HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.errors?.length) {
      throw new Error(`dprice GraphQL: ${json.errors[0].message}`);
    }
    return (json.data.priceHistory as Array<{ date: string; priceUsd: string }>).map(
      (p) => ({ date: p.date, price_usd: p.priceUsd }),
    );
  }

  async sync(): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/api/v1/sync`, { method: "POST" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`dprice sync HTTP ${resp.status}: ${text}`);
    }
    const json = await resp.json();
    return json.status ?? "sync triggered";
  }

  async syncLatest(): Promise<string> {
    // HTTP server sync endpoint handles latest internally
    return this.sync();
  }

  async latestDate(): Promise<string | null> {
    // Use GraphQL to query the global latest date
    const query = `{ health { latestDate } }`;
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      return json.data?.health?.latestDate ?? null;
    } catch {
      return null;
    }
  }

  async ensurePrices(requests: Array<{ symbol: string; date: string }>): Promise<string[]> {
    const missing: string[] = [];
    for (const { symbol, date } of requests) {
      const params = new URLSearchParams({ symbol, date });
      try {
        const resp = await fetch(`${this.baseUrl}/api/v1/price?${params}`);
        if (!resp.ok) missing.push(symbol);
      } catch {
        missing.push(symbol);
      }
    }
    return [...new Set(missing)];
  }

  async exportDb(): Promise<Uint8Array> {
    throw new Error("dprice DB export is not supported in browser mode");
  }

  async importDb(_data: Uint8Array): Promise<string> {
    throw new Error("dprice DB import is not supported in browser mode");
  }
}

const DEFAULT_DPRICE_URL = "http://localhost:3080";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

import type { DpriceMode } from "./data/settings.svelte.js";

export function createDpriceClient(settings?: {
  dpriceMode?: DpriceMode;
  dpriceUrl?: string;
}): DpriceClient {
  const mode = settings?.dpriceMode;
  if (mode === "http") {
    return new HttpDpriceClient(settings?.dpriceUrl ?? DEFAULT_DPRICE_URL);
  }
  if (isTauri) {
    return new TauriDpriceClient();
  }
  // Browser fallback: always HTTP
  return new HttpDpriceClient(settings?.dpriceUrl ?? DEFAULT_DPRICE_URL);
}
