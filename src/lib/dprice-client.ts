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
  queryAssetsBatch(symbols: string[], limit?: number): Promise<Map<string, DpriceAssetInfo[]>>;
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

  async queryAssetsBatch(symbols: string[], limit?: number): Promise<Map<string, DpriceAssetInfo[]>> {
    const raw = await this.invoke<Record<string, DpriceAssetInfo[]>>(
      "dprice_query_assets_batch", { symbols, limit },
    );
    return new Map(Object.entries(raw));
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
  constructor(private baseUrl: string) {
    // Normalize: strip trailing slash to avoid double-slash in URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

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
    opts?: { type?: DpriceAssetType },
  ): Promise<DpriceRateEntry[]> {
    const params = new URLSearchParams({ symbols: currencies.join(",") });
    if (date) params.set("date", date);
    if (opts?.type) params.set("type", opts.type);
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
    // The REST API only supports a single global `type` filter.  When bases
    // contain a mix of types (e.g., fiat EUR + crypto BTS), a single request
    // would either pick wrong assets or filter out valid ones.  Split into
    // groups by (type, hasId) and merge the results.
    const groups = new Map<string, { ids: string[]; symbols: string[] }>();
    for (const b of bases) {
      const key = b.id ? "__id__" : (b.type ?? "");
      let g = groups.get(key);
      if (!g) { g = { ids: [], symbols: [] }; groups.set(key, g); }
      if (b.id) g.ids.push(b.id);
      else if (b.symbol) g.symbols.push(b.symbol);
    }

    const allCurrencies: DpriceBatchResult["currencies"] = [];
    let resultFrom = fromDate;
    let resultTo = toDate;

    for (const [key, g] of groups) {
      const params = new URLSearchParams({ date: fromDate, end_date: toDate });
      if (g.symbols.length > 0) params.set("symbols", g.symbols.join(","));
      if (g.ids.length > 0) params.set("ids", g.ids.join(","));
      if (key !== "__id__" && key !== "") params.set("type", key);

      const resp = await this.fetchJson<PricesApiResponse>(`/api/v1/prices?${params}`);
      resultFrom = resp.date;
      resultTo = resp.end_date ?? resp.date;
      for (const c of resp.currencies) {
        allCurrencies.push({ id: c.id ?? "", symbol: c.base, prices: c.prices });
      }
    }

    return { from: resultFrom, to: resultTo, currencies: allCurrencies };
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
    const resp = await this.fetchJson<{ results: Record<string, DpriceAssetInfo[]> }>(`/api/v1/assets?${params}`);
    // Flatten grouped response for single-filter callers
    return Object.values(resp.results).flat();
  }

  async queryAssetsBatch(symbols: string[], limit?: number): Promise<Map<string, DpriceAssetInfo[]>> {
    const params = new URLSearchParams({ symbol: symbols.join(",") });
    if (limit) params.set("limit", limit.toString());
    const resp = await this.fetchJson<{ results: Record<string, DpriceAssetInfo[]> }>(`/api/v1/assets?${params}`);
    return new Map(Object.entries(resp.results));
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
