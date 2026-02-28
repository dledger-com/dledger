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
    const resp = await fetch(`${this.baseUrl}/graphql`, {
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
}

const DEFAULT_DPRICE_URL = "http://localhost:3080";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export function createDpriceClient(settings?: { dpriceUrl?: string }): DpriceClient {
  if (isTauri) {
    return new TauriDpriceClient();
  }
  return new HttpDpriceClient(settings?.dpriceUrl ?? DEFAULT_DPRICE_URL);
}
