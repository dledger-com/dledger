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

export interface DpriceAssetFilter {
  id?: string;
  symbol?: string;
  type?: DpriceAssetType;
  param?: string;
  coingecko_id?: string;
  contract_chain?: string;
  contract_address?: string;
}

export interface DpriceAssetInfo {
  id: string;
  symbol: string;
  name: string;
  type: DpriceAssetType | string;
  param?: string;
  coingecko_id?: string;
  contract_chain?: string;
  contract_address?: string;
  first_price_date?: string | null;
  last_price_date?: string | null;
}

export interface DpriceBatchCurrency {
  id: string;
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
  getPrices(
    bases: DpriceAssetFilter[],
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
  queryAssets(filter: DpriceAssetFilter, limit?: number): Promise<DpriceAssetInfo[]>;
  exportDb(): Promise<Uint8Array>;
  importDb(data: Uint8Array): Promise<string>;
  proxyAsset(url: string): Promise<Blob | null>;
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

  async getPrices(
    bases: DpriceAssetFilter[],
    fromDate: string,
    toDate: string,
  ): Promise<DpriceBatchResult> {
    return this.invoke("dprice_get_prices", {
      bases,
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

  async queryAssets(filter: DpriceAssetFilter, limit?: number): Promise<DpriceAssetInfo[]> {
    return this.invoke("dprice_query_assets", { filter, limit });
  }

  async exportDb(): Promise<Uint8Array> {
    const data = await this.invoke<number[]>("dprice_export_db");
    return new Uint8Array(data);
  }

  async importDb(data: Uint8Array): Promise<string> {
    return this.invoke("dprice_import_db", { data: Array.from(data) });
  }

  async proxyAsset(url: string): Promise<Blob | null> {
    try {
      const resp = await this.invoke<{ content_type: string; data: number[] }>(
        "dprice_asset_proxy",
        { url },
      );
      return new Blob([new Uint8Array(resp.data)], { type: resp.content_type });
    } catch {
      return null;
    }
  }
}

/** Shape of the unified `/api/v1/prices` response */
interface PricesApiResponse {
  date: string;
  end_date: string | null;
  quote: string;
  currencies: Array<{
    id?: string;
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

  async getPrices(
    bases: DpriceAssetFilter[],
    fromDate: string,
    toDate: string,
  ): Promise<DpriceBatchResult> {
    // Separate ID-based and symbol-based filters for the REST API
    const symbolEntries: string[] = [];
    const idEntries: string[] = [];
    for (const b of bases) {
      if (b.id) idEntries.push(b.id);
      else if (b.symbol) symbolEntries.push(b.symbol);
    }
    const params = new URLSearchParams({ date: fromDate, end_date: toDate });
    if (symbolEntries.length > 0) params.set("symbols", symbolEntries.join(","));
    if (idEntries.length > 0) params.set("ids", idEntries.join(","));
    // If all filters share the same type/param, add them to the query
    const types = new Set(bases.map((b) => b.type).filter(Boolean));
    if (types.size === 1) params.set("type", [...types][0]!);
    const paramVals = new Set(bases.map((b) => b.param).filter(Boolean));
    if (paramVals.size === 1) params.set("param", [...paramVals][0]!);

    const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
    return {
      from: resp.date,
      to: resp.end_date ?? resp.date,
      currencies: resp.currencies.map((c) => ({
        id: c.id ?? "",
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

  async queryAssets(filter: DpriceAssetFilter, limit?: number): Promise<DpriceAssetInfo[]> {
    const params = new URLSearchParams();
    if (filter.id) params.set("id", filter.id);
    if (filter.symbol) params.set("symbol", filter.symbol);
    if (filter.type) params.set("type", filter.type);
    if (filter.param) params.set("param", filter.param);
    if (filter.coingecko_id) params.set("coingecko_id", filter.coingecko_id);
    if (filter.contract_chain) params.set("contract_chain", filter.contract_chain);
    if (filter.contract_address) params.set("contract_address", filter.contract_address);
    if (limit) params.set("limit", limit.toString());
    const resp = await this.fetchJson<{ results: DpriceAssetInfo[] }>(`/api/v1/assets?${params}`);
    return resp.results;
  }

  async exportDb(): Promise<Uint8Array> {
    throw new Error("dprice DB export is not supported in browser mode");
  }

  async importDb(_data: Uint8Array): Promise<string> {
    throw new Error("dprice DB import is not supported in browser mode");
  }

  async proxyAsset(url: string): Promise<Blob | null> {
    try {
      const resp = await fetch(
        `${this.baseUrl}/api/v1/asset-proxy?url=${encodeURIComponent(url)}`,
      );
      if (!resp.ok) return null;
      return resp.blob();
    } catch {
      return null;
    }
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
