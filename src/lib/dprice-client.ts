export type DpriceAssetType = "crypto" | "fiat" | "stock" | "commodity" | "index" | "bond";

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

export interface DpriceBatchCurrency {
  symbol: string;
  prices: [number, string][]; // [YYYYMMDD, price_usd]
}

export interface DpriceBatchResult {
  from: string;
  to: string;
  currencies: DpriceBatchCurrency[];
}

export interface DpriceClient {
  health(): Promise<DpriceHealthResponse>;
  getRate(
    from: string,
    to: string,
    date?: string,
    opts?: { fromType?: DpriceAssetType; toType?: DpriceAssetType; fromParam?: string; toParam?: string },
  ): Promise<string | null>;
  getRates(
    currencies: string[],
    date?: string,
    opts?: { type?: DpriceAssetType },
  ): Promise<DpriceRateEntry[]>;
  getPriceRange(
    symbol: string,
    fromDate: string,
    toDate: string,
    opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<DpricePriceEntry[]>;
  getPriceRangeBatch(
    symbols: string[],
    fromDate: string,
    toDate: string,
  ): Promise<DpriceBatchResult>;
  sync(): Promise<string>;
  syncLatest(): Promise<string>;
  latestDate(): Promise<string | null>;
  ensurePrices(
    requests: Array<{ symbol: string; date: string }>,
    opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<string[]>;
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

  async getRate(
    from: string,
    to: string,
    date?: string,
    opts?: { fromType?: DpriceAssetType; toType?: DpriceAssetType; fromParam?: string; toParam?: string },
  ): Promise<string | null> {
    return this.invoke("dprice_get_rate", {
      from,
      to,
      date,
      fromType: opts?.fromType,
      toType: opts?.toType,
      fromParam: opts?.fromParam,
      toParam: opts?.toParam,
    });
  }

  async getRates(
    currencies: string[],
    date?: string,
    opts?: { type?: DpriceAssetType },
  ): Promise<DpriceRateEntry[]> {
    return this.invoke("dprice_get_rates", {
      currencies,
      date,
      assetType: opts?.type,
    });
  }

  async getPriceRange(
    symbol: string,
    fromDate: string,
    toDate: string,
    opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<DpricePriceEntry[]> {
    return this.invoke("dprice_get_price_range", {
      symbol,
      fromDate,
      toDate,
      assetType: opts?.type,
      param: opts?.param,
    });
  }

  async getPriceRangeBatch(
    symbols: string[],
    fromDate: string,
    toDate: string,
  ): Promise<DpriceBatchResult> {
    return this.invoke("dprice_get_price_ranges_batch", {
      symbols,
      fromDate,
      toDate,
    });
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

  async ensurePrices(
    requests: Array<{ symbol: string; date: string }>,
    opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<string[]> {
    const tuples = requests.map((r) => [r.symbol, r.date]);
    return this.invoke("dprice_ensure_prices", {
      requests: tuples,
      assetType: opts?.type,
      param: opts?.param,
    });
  }

  async exportDb(): Promise<Uint8Array> {
    const data = await this.invoke<number[]>("dprice_export_db");
    return new Uint8Array(data);
  }

  async importDb(data: Uint8Array): Promise<string> {
    return this.invoke("dprice_import_db", { data: Array.from(data) });
  }
}

/** Shape of the unified `/api/v1/prices` response */
interface PricesApiResponse {
  date: string;
  end_date: string | null;
  quote: string;
  currencies: Array<{
    base: string;
    count: number;
    prices: [number, string][]; // [YYYYMMDD, price]
  }>;
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
    return this.fetchJson("/api/v1/status");
  }

  async getRate(
    from: string,
    to: string,
    date?: string,
    _opts?: { fromType?: DpriceAssetType; toType?: DpriceAssetType; fromParam?: string; toParam?: string },
  ): Promise<string | null> {
    const params = new URLSearchParams({ symbols: from, quote: to });
    if (date) params.set("date", date);
    try {
      const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
      return resp.currencies[0]?.prices[0]?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async getRates(
    currencies: string[],
    date?: string,
    _opts?: { type?: DpriceAssetType },
  ): Promise<DpriceRateEntry[]> {
    const params = new URLSearchParams({ symbols: currencies.join(",") });
    if (date) params.set("date", date);
    // Fetch all prices in USD (default quote), then compute cross-rate matrix
    const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
    const usdPrices = new Map<string, number>();
    for (const c of resp.currencies) {
      if (c.prices.length > 0) {
        usdPrices.set(c.base, Number(c.prices[0][1]));
      }
    }
    const entries: DpriceRateEntry[] = [];
    const symbols = [...usdPrices.keys()];
    for (const a of symbols) {
      for (const b of symbols) {
        if (a !== b) {
          entries.push({ from: a, to: b, rate: (usdPrices.get(a)! / usdPrices.get(b)!).toString() });
        }
      }
    }
    return entries;
  }

  async getPriceRange(
    symbol: string,
    fromDate: string,
    toDate: string,
    _opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<DpricePriceEntry[]> {
    const params = new URLSearchParams({ symbols: symbol, date: fromDate, end_date: toDate });
    const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
    if (resp.currencies.length === 0) return [];
    return resp.currencies[0].prices.map(
      ([dateInt, price]) => ({ date: String(dateInt), price_usd: price }),
    );
  }

  async getPriceRangeBatch(
    symbols: string[],
    fromDate: string,
    toDate: string,
  ): Promise<DpriceBatchResult> {
    const params = new URLSearchParams({
      symbols: symbols.join(","),
      date: fromDate,
      end_date: toDate,
    });
    const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
    return {
      from: resp.date,
      to: resp.end_date ?? resp.date,
      currencies: resp.currencies.map((c) => ({
        symbol: c.base,
        prices: c.prices,
      })),
    };
  }

  async sync(): Promise<string> {
    throw new Error("sync not available via HTTP API — use `dprice update` CLI instead");
  }

  async syncLatest(): Promise<string> {
    throw new Error("sync not available via HTTP API — use `dprice update` CLI instead");
  }

  async latestDate(): Promise<string | null> {
    try {
      const resp = await this.fetchJson<{ latest_date: string | null }>("/api/v1/status");
      return resp.latest_date ?? null;
    } catch {
      return null;
    }
  }

  async ensurePrices(
    requests: Array<{ symbol: string; date: string }>,
    _opts?: { type?: DpriceAssetType; param?: string },
  ): Promise<string[]> {
    // Group requests by date for batching
    const byDate = new Map<string, Set<string>>();
    for (const { symbol, date } of requests) {
      let set = byDate.get(date);
      if (!set) { set = new Set(); byDate.set(date, set); }
      set.add(symbol);
    }
    const missing = new Set<string>();
    for (const [date, symbols] of byDate) {
      const params = new URLSearchParams({ symbols: [...symbols].join(","), date });
      try {
        const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
        for (const c of resp.currencies) {
          if (c.prices.length === 0) missing.add(c.base);
        }
        // Symbols not in response at all are also missing
        const returned = new Set(resp.currencies.map((c) => c.base));
        for (const s of symbols) {
          if (!returned.has(s)) missing.add(s);
        }
      } catch {
        for (const s of symbols) missing.add(s);
      }
    }
    return [...missing];
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
