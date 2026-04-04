import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateOverride, RateFetchFailure, CurrencyDateRequirement } from "./backend.js";
import { type SourceName, resolveDpriceAssetsBatch } from "./exchange-rate-sync.js";
import { createDpriceClient } from "./dprice-client.js";
import { isDpriceActive, type DpriceMode } from "./data/settings.svelte.js";
import { setRateHealthSyncing, updateRateHealth } from "./data/rate-health.svelte.js";
import * as m from "$paraglide/messages.js";


// ECB/Frankfurter supported fiat currency codes
const FRANKFURTER_FIAT = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

// Common crypto ticker → CoinGecko ID mapping
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", DOT: "polkadot",
  AVAX: "avalanche-2", MATIC: "matic-network", POL: "matic-network",
  LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos", LTC: "litecoin",
  NEAR: "near", APT: "aptos", ARB: "arbitrum", OP: "optimism",
  FIL: "filecoin", AAVE: "aave", MKR: "maker", SNX: "havven",
  COMP: "compound-governance-token", CRV: "curve-dao-token",
  SHIB: "shiba-inu", PEPE: "pepe", SUI: "sui", SEI: "sei-network",
  TIA: "celestia", USDT: "tether", USDC: "usd-coin", DAI: "dai",
};

// ---- Chain ID → DefiLlama chain name mapping ----

const CHAIN_ID_TO_DEFILLAMA: Record<number, string> = {
  1: "ethereum", 10: "optimism", 42161: "arbitrum",
  8453: "base", 137: "polygon", 56: "bsc",
  43114: "avax", 100: "gnosis", 59144: "linea",
  534352: "scroll", 81457: "blast", 250: "fantom",
  1284: "moonbeam", 1285: "moonriver", 42220: "celo",
  5000: "mantle",
};

export function chainIdToDefiLlamaChain(chainId: number): string | null {
  return CHAIN_ID_TO_DEFILLAMA[chainId] ?? null;
}

// ---- Types ----

export interface HistoricalRateRequest {
  currency: string;
  dates: string[];     // YYYY-MM-DD dates needed for this currency
  source: SourceName;
}

export interface HistoricalFetchConfig {
  baseCurrency: string;
  coingeckoApiKey: string;
  coingeckoPro?: boolean;
  finnhubApiKey: string;
  cryptoCompareApiKey?: string;
  dpriceMode?: DpriceMode;
  dpriceUrl?: string;
  storedSources?: CurrencyRateOverride[];
  onProgress?: (fetched: number, total: number) => void;
  signal?: AbortSignal;
  disabledSources?: Set<string>;
  /** When true, skip internal fallback chains — used by cascade runner */
  skipFallbacks?: boolean;
}

export interface HistoricalFetchResult {
  fetched: number;
  skipped: number;
  errors: string[];
  failedCurrencies: string[];
}

// ---- dprice asset resolution helper ----

/**
 * Resolve which currencies are available in dprice.
 * Returns undefined if dprice is not active or unavailable.
 */
export async function resolveDpriceAssets(
  config: Pick<HistoricalFetchConfig, "dpriceMode" | "dpriceUrl" | "baseCurrency">,
  currencies: string[],
): Promise<Set<string> | undefined> {
  if (!isDpriceActive(config.dpriceMode)) return undefined;
  try {
    const client = createDpriceClient({ dpriceMode: config.dpriceMode, dpriceUrl: config.dpriceUrl });
    // Exclude Frankfurter fiat from untyped getRates to avoid crypto token mismatches
    // (e.g., "USD" matching "Unstable States Dollar" instead of fiat USD)
    const nonFiat = currencies.filter((c) => !FRANKFURTER_FIAT.has(c));
    const entries = await client.getRates(nonFiat);
    const assets = new Set(entries.map((e) => e.from));
    // USD is dprice's base unit (no fiat:USD asset exists) — derive via cross-rate
    if (config.baseCurrency !== "USD") {
      assets.add("USD");
    }
    return assets;
  } catch {
    return undefined;
  }
}

// ---- Source classification ----

function classifySource(
  currency: string,
  assetType: string,
  baseCurrency: string,
  rateSourceMap: Map<string, CurrencyRateOverride>,
  tokenAddressCurrencies?: Set<string>,
  dpriceAssets?: Set<string>,
  disabledSources?: Set<string>,
): SourceName | null {
  // 1. When dprice is active and asset is available, prefer it (unless user override)
  if (dpriceAssets?.has(currency)) {
    const stored = rateSourceMap.get(currency);
    if (!stored || stored.set_by !== "user" || stored.rate_source === "dprice") {
      return "dprice";
    }
  }
  // 2. User/handler override (respect disabled flag)
  const stored = rateSourceMap.get(currency);
  if (stored?.rate_source === "none") return null;
  if (stored?.rate_source) {
    const src = stored.rate_source as SourceName;
    return disabledSources?.has(src) ? null : src;
  }
  // Helper: pick first enabled crypto source
  const pickCryptoSource = (hasCoinId: boolean): SourceName | null => {
    if (!disabledSources?.has("defillama")) return "defillama";
    if (hasCoinId && !disabledSources?.has("coingecko")) return "coingecko";
    if (!disabledSources?.has("binance")) return "binance";
    return null;
  };
  // 3. Asset-type based routing (when classified)
  if (assetType === "fiat" && FRANKFURTER_FIAT.has(baseCurrency)) {
    return disabledSources?.has("frankfurter") ? null : "frankfurter";
  }
  if (assetType === "crypto") {
    // Trust the "crypto" classification — try crypto sources even for non-hardcoded tokens
    return pickCryptoSource(!!COINGECKO_IDS[currency]);
  }
  if (assetType === "stock" || assetType === "commodity" || assetType === "index" || assetType === "bond") return null;
  // 4. Unclassified fallback: existing heuristics
  if (FRANKFURTER_FIAT.has(currency) && FRANKFURTER_FIAT.has(baseCurrency)) {
    return disabledSources?.has("frankfurter") ? null : "frankfurter";
  }
  if (tokenAddressCurrencies?.has(currency) || COINGECKO_IDS[currency]) {
    return pickCryptoSource(!!COINGECKO_IDS[currency]);
  }
  // Last resort: try defillama for any unclassified currency
  if (!disabledSources?.has("defillama")) return "defillama";
  return null;
}

// ---- Find missing rates ----

export async function findMissingRates(
  backend: Backend,
  baseCurrency: string,
  currencyDates: { currency: string; date: string }[],
  dpriceAssets?: Set<string>,
  options?: { exactDateMatch?: boolean },
  disabledSources?: Set<string>,
  unsourceableCurrencies?: Set<string>,
  preloaded?: {
    storedSources?: CurrencyRateOverride[];
    currencyTypeMap?: Map<string, string>;
    tokenAddrCurrencies?: Set<string>;
  },
): Promise<HistoricalRateRequest[]> {
  // Deduplicate
  const seen = new Set<string>();
  const unique: { currency: string; date: string }[] = [];
  for (const cd of currencyDates) {
    if (cd.currency === baseCurrency) continue;
    const key = `${cd.currency}:${cd.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cd);
  }

  // Use pre-loaded data or load from DB
  const storedSources = preloaded?.storedSources ?? await backend.getCurrencyRateOverrides();
  const rateSourceMap = new Map<string, CurrencyRateOverride>();
  for (const src of storedSources) {
    rateSourceMap.set(src.currency, src);
  }

  const tokenAddrCurrencies = preloaded?.tokenAddrCurrencies ?? new Set(
    (await backend.getCurrencyTokenAddresses()).map((t) => t.currency),
  );

  const currencyTypeMap = preloaded?.currencyTypeMap ?? new Map(
    (await backend.listCurrencies()).map((c) => [c.code, c.asset_type]),
  );

  // Check which rates are missing — batch if available
  const missing = new Map<string, { currency: string; dates: string[]; source: SourceName }>();

  const useExact = options?.exactDateMatch;

  if (useExact && backend.getExchangeRatesBatchExact && unique.length > 0) {
    // Exact date matching — a rate from January does NOT satisfy a June lookup
    const existenceMap = await backend.getExchangeRatesBatchExact(unique, baseCurrency);
    for (const { currency, date } of unique) {
      const key = `${currency}:${date}`;
      if (existenceMap.get(key)) continue;

      const source = classifySource(currency, currencyTypeMap.get(currency) ?? "", baseCurrency, rateSourceMap, tokenAddrCurrencies, dpriceAssets, disabledSources);
      if (!source) {
        const stored = rateSourceMap.get(currency);
        if (!(stored?.set_by === "user" && stored?.rate_source === "none")) {
          unsourceableCurrencies?.add(currency);
        }
        continue;
      }
      const groupKey = `${currency}:${source}`;
      if (!missing.has(groupKey)) {
        missing.set(groupKey, { currency, dates: [], source });
      }
      missing.get(groupKey)!.dates.push(date);
    }
  } else if (backend.getExchangeRatesBatch && unique.length > 0) {
    const existenceMap = await backend.getExchangeRatesBatch(unique, baseCurrency);
    for (const { currency, date } of unique) {
      const key = `${currency}:${date}`;
      if (existenceMap.get(key)) continue;

      const source = classifySource(currency, currencyTypeMap.get(currency) ?? "", baseCurrency, rateSourceMap, tokenAddrCurrencies, dpriceAssets, disabledSources);
      if (!source) {
        const stored = rateSourceMap.get(currency);
        if (!(stored?.set_by === "user" && stored?.rate_source === "none")) {
          unsourceableCurrencies?.add(currency);
        }
        continue;
      }
      const groupKey = `${currency}:${source}`;
      if (!missing.has(groupKey)) {
        missing.set(groupKey, { currency, dates: [], source });
      }
      missing.get(groupKey)!.dates.push(date);
    }
  } else {
    for (const { currency, date } of unique) {
      const rate = await backend.getExchangeRate(currency, baseCurrency, date);
      if (rate !== null) continue;

      const source = classifySource(currency, currencyTypeMap.get(currency) ?? "", baseCurrency, rateSourceMap, tokenAddrCurrencies, dpriceAssets, disabledSources);
      if (!source) {
        const stored = rateSourceMap.get(currency);
        if (!(stored?.set_by === "user" && stored?.rate_source === "none")) {
          unsourceableCurrencies?.add(currency);
        }
        continue;
      }
      const groupKey = `${currency}:${source}`;
      if (!missing.has(groupKey)) {
        missing.set(groupKey, { currency, dates: [], source });
      }
      missing.get(groupKey)!.dates.push(date);
    }
  }

  return Array.from(missing.values()).map((m) => ({
    currency: m.currency,
    dates: m.dates.sort(),
    source: m.source,
  }));
}

// ---- Main historical fetch entry point ----

export async function fetchHistoricalRates(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  dpriceAssets?: Set<string>,
): Promise<HistoricalFetchResult> {
  const result: HistoricalFetchResult = { fetched: 0, skipped: 0, errors: [], failedCurrencies: [] };
  const totalDates = requests.reduce((sum, r) => sum + r.dates.length, 0);
  let progress = 0;

  // Track which currencies got at least one rate
  const successCurrencies = new Set<string>();
  const allCurrencies = new Set(requests.map((r) => r.currency));

  // Group requests by source
  const frankfurterReqs = requests.filter((r) => r.source === "frankfurter");
  const coingeckoReqs = requests.filter((r) => r.source === "coingecko");
  const finnhubReqs = requests.filter((r) => r.source === "finnhub");
  const defillamaReqs = requests.filter((r) => r.source === "defillama");
  const cryptocompareReqs = requests.filter((r) => r.source === "cryptocompare");
  const binanceReqs = requests.filter((r) => r.source === "binance");
  const dpriceReqs = requests.filter((r) => r.source === "dprice");

  const tick = () => { progress++; config.onProgress?.(progress, totalDates); };

  // ---- dprice: local price DB historical (FIRST — avoids redundant external API calls) ----
  if (dpriceReqs.length > 0 && isDpriceActive(config.dpriceMode) && !config.signal?.aborted) {
    // Load currency types for dprice filter disambiguation (fiat vs crypto)
    const allCurrenciesList = await backend.listCurrencies();
    const currencyTypeMap = new Map(allCurrenciesList.map((c) => [c.code, c.asset_type]));
    await fetchDpriceHistorical(backend, dpriceReqs, config, result, successCurrencies, tick, currencyTypeMap);
  }

  // ---- Frankfurter: full timeseries, multi-symbol ----
  if (frankfurterReqs.length > 0 && !config.disabledSources?.has("frankfurter") && !config.signal?.aborted) {
    await fetchFrankfurterHistorical(backend, frankfurterReqs, config, result, successCurrencies, tick);
  }

  // ---- CoinGecko: market_chart/range per coin ----
  if (coingeckoReqs.length > 0 && !config.disabledSources?.has("coingecko") && !config.signal?.aborted) {
    if (!config.coingeckoApiKey) {
      result.errors.push(`CoinGecko: no API key; skipping ${coingeckoReqs.length} currency(ies)`);
    } else {
      await fetchCoinGeckoHistorical(backend, coingeckoReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- Finnhub: candle per symbol ----
  if (finnhubReqs.length > 0 && !config.disabledSources?.has("finnhub") && !config.signal?.aborted) {
    if (!config.finnhubApiKey) {
      result.errors.push(`Finnhub: no API key; skipping ${finnhubReqs.length} currency(ies)`);
    } else {
      await fetchFinnhubHistorical(backend, finnhubReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- CryptoCompare: histoday per symbol ----
  if (cryptocompareReqs.length > 0 && !config.disabledSources?.has("cryptocompare") && !config.signal?.aborted) {
    if (!config.cryptoCompareApiKey) {
      result.errors.push(`CryptoCompare: no API key; skipping ${cryptocompareReqs.length} currency(ies)`);
    } else {
      await fetchCryptoCompareHistorical(backend, cryptocompareReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- DefiLlama: batch historical ----
  if (defillamaReqs.length > 0 && !config.disabledSources?.has("defillama") && !config.signal?.aborted) {
    await fetchDefiLlamaHistorical(backend, defillamaReqs, config, result, successCurrencies, tick);
  }

  // ---- Binance: klines per symbol ----
  if (binanceReqs.length > 0 && !config.disabledSources?.has("binance") && !config.signal?.aborted) {
    await fetchBinanceHistorical(backend, binanceReqs, config, result, successCurrencies, tick);
  }

  // Fallback chain: if primary source failed, try alternatives (unless cascade runner manages this)
  if (!config.skipFallbacks) {
    const failedAfterPrimary = new Set<string>();
    for (const currency of allCurrencies) {
      if (!successCurrencies.has(currency)) {
        failedAfterPrimary.add(currency);
      }
    }

    // Fallback: if dprice failed for some currencies, re-classify without dprice and retry
    if (failedAfterPrimary.size > 0 && !config.signal?.aborted) {
      const storedSources = config.storedSources ?? await backend.getCurrencyRateOverrides();
      const rateSourceMap = new Map<string, CurrencyRateOverride>();
      for (const src of storedSources) rateSourceMap.set(src.currency, src);
      const tokenAddresses = await backend.getCurrencyTokenAddresses();
      const tokenAddrCurrencies = new Set(tokenAddresses.map((t) => t.currency));
      const allCurrenciesList = await backend.listCurrencies();
      const currencyTypeMap = new Map<string, string>();
      for (const c of allCurrenciesList) currencyTypeMap.set(c.code, c.asset_type);

      const failedDprice = requests.filter((r) => failedAfterPrimary.has(r.currency) && r.source === "dprice");
      if (failedDprice.length > 0) {
        const fallbackBySource = new Map<SourceName, HistoricalRateRequest[]>();
        for (const req of failedDprice) {
          const fallback = classifySource(req.currency, currencyTypeMap.get(req.currency) ?? "", config.baseCurrency, rateSourceMap, tokenAddrCurrencies, undefined, config.disabledSources);
          if (!fallback || fallback === "dprice") continue;
          if (!fallbackBySource.has(fallback)) fallbackBySource.set(fallback, []);
          fallbackBySource.get(fallback)!.push({ ...req, source: fallback });
        }

        const sourceOrder: SourceName[] = ["frankfurter", "coingecko", "defillama", "finnhub", "cryptocompare", "binance"];
        for (const source of sourceOrder) {
          if (config.signal?.aborted) break;
          const reqs = fallbackBySource.get(source);
          if (!reqs) continue;
          if (source === "frankfurter") await fetchFrankfurterHistorical(backend, reqs, config, result, successCurrencies, tick);
          else if (source === "coingecko" && config.coingeckoApiKey) await fetchCoinGeckoHistorical(backend, reqs, config, result, successCurrencies, tick);
          else if (source === "defillama") await fetchDefiLlamaHistorical(backend, reqs, config, result, successCurrencies, tick);
          else if (source === "finnhub" && config.finnhubApiKey) await fetchFinnhubHistorical(backend, reqs, config, result, successCurrencies, tick);
          else if (source === "cryptocompare" && config.cryptoCompareApiKey) await fetchCryptoCompareHistorical(backend, reqs, config, result, successCurrencies, tick);
          else if (source === "binance") await fetchBinanceHistorical(backend, reqs, config, result, successCurrencies, tick);
        }
      }
    }

    if (failedAfterPrimary.size > 0 && config.coingeckoApiKey && !config.signal?.aborted) {
      const stillFailed = new Set<string>();
      for (const currency of failedAfterPrimary) {
        if (!successCurrencies.has(currency)) stillFailed.add(currency);
      }
      const fallbackReqs = requests
        .filter((r) => stillFailed.has(r.currency) && r.source === "defillama")
        .map((r) => ({ ...r, source: "coingecko" as SourceName }));
      if (fallbackReqs.length > 0) {
        await fetchCoinGeckoHistorical(backend, fallbackReqs, config, result, successCurrencies, tick);
      }
    }
  }

  // Compute failed currencies: requested but never succeeded
  for (const currency of allCurrencies) {
    if (!successCurrencies.has(currency)) {
      result.failedCurrencies.push(currency);
    }
  }

  return result;
}

// ---- Frankfurter historical ----

interface FrankfurterTimeseriesResponse {
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
}

async function fetchFrankfurterHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  // Collect all dates and currencies
  const allDates = new Set<string>();
  const allCurrencies = new Set<string>();
  const neededSet = new Set<string>(); // "CURRENCY:DATE"
  for (const req of requests) {
    allCurrencies.add(req.currency);
    for (const date of req.dates) {
      allDates.add(date);
      neededSet.add(`${req.currency}:${date}`);
    }
  }

  const sortedDates = [...allDates].sort();
  if (sortedDates.length === 0) return;

  const startDate = sortedDates[0];
  const endDate = sortedDates[sortedDates.length - 1];
  const symbols = [...allCurrencies].join(",");

  // Chunk into yearly segments for reliability
  const chunks = chunkDateRange(startDate, endDate, 365);

  // Collect all rates for batch insert
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  for (const [chunkStart, chunkEnd] of chunks) {
    if (config.signal?.aborted) break;
    try {
      const url = `https://api.frankfurter.dev/v1/${chunkStart}..${chunkEnd}?base=${config.baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url, { signal: config.signal });
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
        continue;
      }
      const data: FrankfurterTimeseriesResponse = await resp.json();

      for (const [date, rates] of Object.entries(data.rates)) {
        for (const [code, rateValue] of Object.entries(rates)) {
          const exactKey = `${code}:${date}`;
          if (neededSet.has(exactKey)) {
            neededSet.delete(exactKey);
          } else {
            // Frankfurter returns rates for business days only — weekend/holiday dates
            // shift to the nearest prior business day. Accept if within 5 days of a needed date.
            const returnedDate = new Date(date + "T00:00:00");
            let matched = false;
            for (const needed of neededSet) {
              if (!needed.startsWith(code + ":")) continue;
              const neededDate = new Date(needed.split(":")[1] + "T00:00:00");
              const diffDays = Math.abs((neededDate.getTime() - returnedDate.getTime()) / 86400000);
              if (diffDays <= 5) {
                neededSet.delete(needed);
                matched = true;
                break;
              }
            }
            if (!matched) continue; // Not near any needed date — skip
          }
          successCurrencies.add(code);
          await ensureCurrency(backend, code);
          await ensureCurrency(backend, config.baseCurrency);
          const invertedRate = 1 / rateValue;
          rateBatch.push({
            id: uuidv7(),
            date,
            from_currency: code,
            to_currency: config.baseCurrency,
            rate: invertedRate.toString(),
            source: "frankfurter",
          });
          result.fetched++;
          onDateDone();
        }
      }
    } catch (err) {
      if (config.signal?.aborted) break;
      result.errors.push(`Frankfurter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Batch insert all collected rates
  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- CoinGecko historical ----

interface CoinGeckoMarketChartResponse {
  prices: [number, number][]; // [unix_ms, price]
}

async function fetchCoinGeckoHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const geckoFetch = new RateLimitedFetcher({ maxRequests: 25, intervalMs: 60_000 });
  const onAbort = () => geckoFetch.dispose();
  config.signal?.addEventListener("abort", onAbort, { once: true });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];
  try {
    for (const req of requests) {
      if (config.signal?.aborted) break;
      const geckoId = COINGECKO_IDS[req.currency] ?? req.currency.toLowerCase();
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      const fromUnix = Math.floor(new Date(sortedDates[0]).getTime() / 1000) - 86400;
      const toUnix = Math.floor(new Date(sortedDates[sortedDates.length - 1]).getTime() / 1000) + 86400;
      const vsBase = config.baseCurrency.toLowerCase();

      try {
        const url = config.coingeckoPro
          ? `https://pro-api.coingecko.com/api/v3/coins/${geckoId}/market_chart/range?vs_currency=${vsBase}&from=${fromUnix}&to=${toUnix}`
          : `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart/range?vs_currency=${vsBase}&from=${fromUnix}&to=${toUnix}`;
        const headers: Record<string, string> = config.coingeckoPro
          ? { "x-cg-pro-api-key": config.coingeckoApiKey }
          : { "x-cg-demo-api-key": config.coingeckoApiKey };
        const resp = await geckoFetch.fetch(url, { headers, signal: config.signal });
        if (!resp.ok) {
          result.errors.push(`CoinGecko HTTP ${resp.status} for ${req.currency}`);
          continue;
        }
        const data: CoinGeckoMarketChartResponse = await resp.json();

        // Map prices to dates
        const dateMap = new Map<string, number>();
        for (const [unixMs, price] of data.prices) {
          const date = new Date(unixMs).toISOString().slice(0, 10);
          dateMap.set(date, price);
        }

        await ensureCurrency(backend, req.currency);
        await ensureCurrency(backend, config.baseCurrency);

        for (const date of neededDates) {
          const price = dateMap.get(date) ?? findNearestPrice(dateMap, date, 1);
          if (price != null) {
            successCurrencies.add(req.currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: req.currency,
              to_currency: config.baseCurrency,
              rate: price.toString(),
              source: "coingecko",
            });
            result.fetched++;
            onDateDone();
          } else {
            result.skipped++;
            onDateDone();
          }
        }
      } catch (err) {
        if (config.signal?.aborted) break;
        result.errors.push(`CoinGecko ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    geckoFetch.dispose();
  }

  // Batch insert all collected rates
  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- Finnhub historical ----

interface FinnhubCandleResponse {
  c: number[];  // close prices
  t: number[];  // timestamps (unix seconds)
  s: string;    // status
}

async function fetchFinnhubHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const finnhubFetch = new RateLimitedFetcher({ maxRequests: 50, intervalMs: 60_000 });
  const onAbort = () => finnhubFetch.dispose();
  config.signal?.addEventListener("abort", onAbort, { once: true });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];
  try {
    for (const req of requests) {
      if (config.signal?.aborted) break;
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      const fromUnix = Math.floor(new Date(sortedDates[0]).getTime() / 1000) - 86400;
      const toUnix = Math.floor(new Date(sortedDates[sortedDates.length - 1]).getTime() / 1000) + 86400;

      try {
        const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(req.currency)}&resolution=D&from=${fromUnix}&to=${toUnix}`;
        const resp = await finnhubFetch.fetch(url, { headers: { "X-Finnhub-Token": config.finnhubApiKey }, signal: config.signal });
        if (!resp.ok) {
          result.errors.push(`Finnhub HTTP ${resp.status} for ${req.currency}`);
          continue;
        }
        const data: FinnhubCandleResponse = await resp.json();
        if (data.s !== "ok" || !data.c || !data.t) {
          result.errors.push(`Finnhub: no candle data for ${req.currency}`);
          continue;
        }

        // Map timestamps to dates
        const dateMap = new Map<string, number>();
        for (let i = 0; i < data.t.length; i++) {
          const date = new Date(data.t[i] * 1000).toISOString().slice(0, 10);
          dateMap.set(date, data.c[i]);
        }

        // Finnhub returns USD prices
        const toCurrency = "USD";
        await ensureCurrency(backend, req.currency);
        await ensureCurrency(backend, toCurrency);

        for (const date of neededDates) {
          const price = dateMap.get(date) ?? findNearestPrice(dateMap, date, 3);
          if (price != null) {
            successCurrencies.add(req.currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: req.currency,
              to_currency: toCurrency,
              rate: price.toString(),
              source: "finnhub",
            });
            result.fetched++;
            onDateDone();
          } else {
            result.skipped++;
            onDateDone();
          }
        }
      } catch (err) {
        if (config.signal?.aborted) break;
        result.errors.push(`Finnhub ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    finnhubFetch.dispose();
  }

  // Batch insert all collected rates
  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- DefiLlama historical ----

async function fetchDefiLlamaHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const llamaFetch = new RateLimitedFetcher({ maxRequests: 400, intervalMs: 60_000 });
  const onAbort = () => llamaFetch.dispose();
  config.signal?.addEventListener("abort", onAbort, { once: true });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  // Load token addresses for coin ID resolution
  const tokenAddresses = await backend.getCurrencyTokenAddresses();
  const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));

  // Resolve coin IDs and build a date→coins index for batching
  const coinIdByCurrency = new Map<string, string>();
  const dateToCoins = new Map<string, Set<string>>(); // date → Set<coinId>

  for (const req of requests) {
    const ta = tokenAddrMap.get(req.currency);
    let coinId: string;
    if (ta) {
      coinId = `${ta.chain}:${ta.contract_address}`;
    } else if (COINGECKO_IDS[req.currency]) {
      coinId = `coingecko:${COINGECKO_IDS[req.currency]}`;
    } else {
      result.errors.push(`DefiLlama: no token address or CoinGecko mapping for ${req.currency}`);
      for (const _d of req.dates) onDateDone();
      continue;
    }
    coinIdByCurrency.set(req.currency, coinId);
    for (const date of req.dates) {
      let set = dateToCoins.get(date);
      if (!set) { set = new Set(); dateToCoins.set(date, set); }
      set.add(coinId);
    }
  }

  // Reverse map: coinId → currency code
  const coinToCurrency = new Map<string, string>();
  for (const [cur, cid] of coinIdByCurrency) coinToCurrency.set(cid, cur);

  // Fetch using GET /prices/historical/{timestamp}/{coins} — one request per date,
  // batching all coins for that date into a single comma-separated call.
  const toCurrency = "USD";
  const ensured = new Set<string>();

  try {
    for (const [date, coinSet] of [...dateToCoins.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (config.signal?.aborted) break;
      const timestamp = Math.floor(new Date(date + "T12:00:00Z").getTime() / 1000);
      const coinList = [...coinSet].join(",");
      const url = `https://coins.llama.fi/prices/historical/${timestamp}/${coinList}?searchWidth=21600`;

      try {
        const resp = await llamaFetch.fetch(url, { signal: config.signal });
        if (!resp.ok) {
          result.errors.push(`DefiLlama HTTP ${resp.status} for date ${date}`);
          for (const _c of coinSet) onDateDone();
          continue;
        }

        const data = await resp.json() as { coins: Record<string, { price: number; symbol?: string; timestamp?: number; confidence?: number }> };

        for (const coinId of coinSet) {
          const currency = coinToCurrency.get(coinId)!;
          const coinData = data.coins[coinId];
          if (coinData && coinData.price != null) {
            if (!ensured.has(currency)) { await ensureCurrency(backend, currency); ensured.add(currency); }
            if (!ensured.has(toCurrency)) { await ensureCurrency(backend, toCurrency); ensured.add(toCurrency); }
            successCurrencies.add(currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: currency,
              to_currency: toCurrency,
              rate: coinData.price.toString(),
              source: "defillama",
            });
            result.fetched++;
          } else {
            result.skipped++;
          }
          onDateDone();
        }
      } catch (err) {
        if (config.signal?.aborted) break;
        result.errors.push(`DefiLlama date ${date}: ${err instanceof Error ? err.message : String(err)}`);
        for (const _c of coinSet) onDateDone();
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    llamaFetch.dispose();
  }

  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- CryptoCompare historical ----

async function fetchCryptoCompareHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const ccFetch = new RateLimitedFetcher({ maxRequests: 50, intervalMs: 60_000 });
  const onAbort = () => ccFetch.dispose();
  config.signal?.addEventListener("abort", onAbort, { once: true });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  try {
    for (const req of requests) {
      if (config.signal?.aborted) break;
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      // CryptoCompare histoday returns up to 2000 data points
      // Calculate limit from earliest to latest date
      const earliest = new Date(sortedDates[0]);
      const latest = new Date(sortedDates[sortedDates.length - 1]);
      const daysDiff = Math.ceil((latest.getTime() - earliest.getTime()) / 86400000) + 1;
      const limit = Math.min(daysDiff, 2000);

      // toTs = latest date as unix timestamp
      const toTs = Math.floor(latest.getTime() / 1000) + 86400;

      try {
        const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${req.currency}&tsym=${config.baseCurrency}&limit=${limit}&toTs=${toTs}`;
        const resp = await ccFetch.fetch(url, { headers: { authorization: `Apikey ${config.cryptoCompareApiKey}` }, signal: config.signal });
        if (!resp.ok) {
          result.errors.push(`CryptoCompare HTTP ${resp.status} for ${req.currency}`);
          continue;
        }

        const data = await resp.json() as { Response: string; Data?: { Data?: Array<{ time: number; close: number }> } };
        if (data.Response !== "Success" || !data.Data?.Data) {
          result.errors.push(`CryptoCompare: no data for ${req.currency}`);
          continue;
        }

        const dateMap = new Map<string, number>();
        for (const point of data.Data.Data) {
          const date = new Date(point.time * 1000).toISOString().slice(0, 10);
          if (point.close > 0) {
            dateMap.set(date, point.close);
          }
        }

        await ensureCurrency(backend, req.currency);
        await ensureCurrency(backend, config.baseCurrency);

        for (const date of neededDates) {
          const price = dateMap.get(date) ?? findNearestPrice(dateMap, date, 1);
          if (price != null) {
            successCurrencies.add(req.currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: req.currency,
              to_currency: config.baseCurrency,
              rate: price.toString(),
              source: "cryptocompare",
            });
            result.fetched++;
            onDateDone();
          } else {
            result.skipped++;
            onDateDone();
          }
        }
      } catch (err) {
        if (config.signal?.aborted) break;
        result.errors.push(`CryptoCompare ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    ccFetch.dispose();
  }

  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- Binance historical ----

async function fetchBinanceHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const binanceFetch = new RateLimitedFetcher({ maxRequests: 200, intervalMs: 60_000 });
  const onAbort = () => binanceFetch.dispose();
  config.signal?.addEventListener("abort", onAbort, { once: true });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  const quoteMap: Record<string, string> = { USD: "USDT", EUR: "EUR" };
  const quote = quoteMap[config.baseCurrency] ?? config.baseCurrency;

  try {
    for (const req of requests) {
      if (config.signal?.aborted) break;
      const pair = `${req.currency}${quote}`;
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      const startMs = new Date(sortedDates[0]).getTime();
      const endMs = new Date(sortedDates[sortedDates.length - 1]).getTime() + 86400000;

      // Chunk into 1000-candle segments (~2.7 years per call)
      const chunks: [number, number][] = [];
      let cursor = startMs;
      while (cursor < endMs) {
        const chunkEnd = Math.min(cursor + 1000 * 86400000, endMs);
        chunks.push([cursor, chunkEnd]);
        cursor = chunkEnd;
      }

      const dateMap = new Map<string, number>();

      try {
        for (const [cStart, cEnd] of chunks) {
          if (config.signal?.aborted) break;
          const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${cStart}&endTime=${cEnd}&limit=1000`;
          const resp = await binanceFetch.fetch(url, { signal: config.signal });
          if (!resp.ok) {
            result.errors.push(`Binance HTTP ${resp.status} for ${req.currency} (${pair})`);
            break;
          }

          const data = await resp.json() as Array<[number, string, string, string, string, ...unknown[]]>;
          for (const kline of data) {
            const date = new Date(kline[0]).toISOString().slice(0, 10);
            const close = parseFloat(kline[4]); // close price
            if (close > 0) {
              dateMap.set(date, close);
            }
          }
        }

        if (dateMap.size === 0) {
          result.errors.push(`Binance: no kline data for ${req.currency} (${pair})`);
          continue;
        }

        const toCurrency = config.baseCurrency;
        await ensureCurrency(backend, req.currency);
        await ensureCurrency(backend, toCurrency);

        for (const date of neededDates) {
          const price = dateMap.get(date) ?? findNearestPrice(dateMap, date, 3);
          if (price != null) {
            successCurrencies.add(req.currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: req.currency,
              to_currency: toCurrency,
              rate: price.toString(),
              source: "binance",
            });
            result.fetched++;
            onDateDone();
          } else {
            result.skipped++;
            onDateDone();
          }
        }
      } catch (err) {
        if (config.signal?.aborted) break;
        result.errors.push(`Binance ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    binanceFetch.dispose();
  }

  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- dprice historical (local price DB) ----

/** Convert YYYYMMDD integer to "YYYY-MM-DD" string. */
function dateIntToString(n: number): string {
  const year = Math.floor(n / 10000);
  const month = Math.floor((n % 10000) / 100);
  const day = n % 100;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function fetchDpriceHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
  currencyTypeMap?: Map<string, string>,
): Promise<void> {
  const client = createDpriceClient({ dpriceMode: config.dpriceMode, dpriceUrl: config.dpriceUrl });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  // Collect all symbols and compute a global date range for the batch call
  const allSymbols = new Set<string>();
  let globalFrom = "9999-12-31";
  let globalTo = "0000-01-01";

  for (const req of requests) {
    if (req.dates.length === 0) continue;
    allSymbols.add(req.currency);
    const sorted = [...req.dates].sort();
    if (sorted[0] < globalFrom) globalFrom = sorted[0];
    if (sorted[sorted.length - 1] > globalTo) globalTo = sorted[sorted.length - 1];
  }

  // Include base currency if non-USD (needed for cross-rates)
  if (config.baseCurrency !== "USD") {
    allSymbols.add(config.baseCurrency);
  }

  if (allSymbols.size === 0) {
    for (const req of requests) {
      for (const _d of req.dates) onDateDone();
    }
    return;
  }

  try {
    // dprice asset IDs are stored in crypto_asset_info.dprice_asset_id
    // For now, use symbol-based resolution (dprice disambiguates internally)
    const idMap = new Map<string, string>();
    const filters = [...allSymbols].map(s => {
      const id = idMap.get(s);
      if (id) return { id };
      // Use DB asset_type, or infer "fiat" for known Frankfurter currencies
      const assetType = currencyTypeMap?.get(s) || (FRANKFURTER_FIAT.has(s) ? "fiat" : "");
      return assetType ? { symbol: s, type: assetType as import("./dprice-client.js").DpriceAssetType } : { symbol: s };
    });

    // Single batch request for all symbols across the full date range
    const batch = await client.getPrices(filters, globalFrom, globalTo);

    // Build per-symbol lookup maps: date string → price_usd string
    const priceMaps = new Map<string, Map<string, string>>();
    for (const entry of batch.currencies) {
      const dateMap = new Map<string, string>();
      for (const [dateInt, priceUsd] of entry.prices) {
        dateMap.set(dateIntToString(dateInt), priceUsd);
      }
      priceMaps.set(entry.symbol.toUpperCase(), dateMap);
    }

    const basePriceMap = config.baseCurrency !== "USD"
      ? priceMaps.get(config.baseCurrency.toUpperCase()) ?? new Map<string, string>()
      : null;

    // Ensure currencies exist in ledger
    const currenciesToEnsure = new Set<string>();
    for (const req of requests) currenciesToEnsure.add(req.currency);
    currenciesToEnsure.add(config.baseCurrency);
    for (const c of currenciesToEnsure) {
      await ensureCurrency(backend, c);
    }

    // Process each request using pre-built maps
    for (const req of requests) {
      if (config.signal?.aborted) break;
      const sortedDates = [...req.dates].sort();
      if (sortedDates.length === 0) continue;

      const dateMap = priceMaps.get(req.currency.toUpperCase());

      for (const date of sortedDates) {
        // dprice prices everything in USD, so "USD's price in USD" is trivially 1.
        // Synthesize it so the cross-rate computation (1 / EUR_USD) works.
        const usdPrice = dateMap?.get(date) ?? (req.currency === "USD" ? "1" : null);
        if (usdPrice == null) {
          result.skipped++;
          onDateDone();
          continue;
        }

        let finalRate: string;
        let toCurrency: string;
        if (basePriceMap) {
          const baseUsd = basePriceMap.get(date);
          if (baseUsd == null || parseFloat(baseUsd) === 0) {
            // Cross-rate unavailable — fall back to storing as X→USD so
            // the transitive lookup path (X→USD→baseCurrency) can still work
            if (req.currency === "USD") { onDateDone(); continue; } // Skip self-rate
            if (!currenciesToEnsure.has("USD")) { await ensureCurrency(backend, "USD"); currenciesToEnsure.add("USD"); }
            successCurrencies.add(req.currency);
            rateBatch.push({
              id: uuidv7(),
              date,
              from_currency: req.currency,
              to_currency: "USD",
              rate: usdPrice,
              source: "dprice",
            });
            result.fetched++;
            onDateDone();
            continue;
          }
          finalRate = (parseFloat(usdPrice) / parseFloat(baseUsd)).toString();
          toCurrency = config.baseCurrency;
        } else {
          finalRate = usdPrice;
          toCurrency = "USD";
        }

        // Never store self-rates (X→X)
        if (req.currency === toCurrency) {
          onDateDone();
          continue;
        }

        successCurrencies.add(req.currency);
        rateBatch.push({
          id: uuidv7(),
          date,
          from_currency: req.currency,
          to_currency: toCurrency,
          rate: finalRate,
          source: "dprice",
        });
        result.fetched++;
        onDateDone();
      }
    }
  } catch (err) {
    result.errors.push(`dprice batch: ${err instanceof Error ? err.message : String(err)}`);
    for (const req of requests) {
      for (const _d of req.dates) onDateDone();
    }
  }

  if (rateBatch.length > 0) {
    if (backend.recordExchangeRateBatch) {
      await backend.recordExchangeRateBatch(rateBatch);
    } else {
      for (const rate of rateBatch) {
        await backend.recordExchangeRate(rate);
      }
    }
  }
}

// ---- Ensure periodic rates (for charts) ----

export async function ensurePeriodicRates(
  backend: Backend,
  currencies: string[],
  fromDate: string,
  toDate: string,
  intervalDays: number,
  config: HistoricalFetchConfig,
): Promise<HistoricalFetchResult> {
  // Generate target dates at intervalDays intervals
  const targets: { currency: string; date: string }[] = [];
  for (const currency of currencies) {
    if (currency === config.baseCurrency) continue;
    let current = new Date(fromDate);
    const end = new Date(toDate);
    while (current <= end) {
      targets.push({ currency, date: current.toISOString().slice(0, 10) });
      current.setDate(current.getDate() + intervalDays);
    }
  }

  const missing = await findMissingRates(backend, config.baseCurrency, targets, undefined, undefined, config.disabledSources);
  if (missing.length === 0) return { fetched: 0, skipped: 0, errors: [], failedCurrencies: [] };

  return fetchHistoricalRates(backend, missing, config);
}

// ---- Auto-backfill ----

export interface AutoBackfillResult extends HistoricalFetchResult {
  currenciesAnalyzed: number;
  totalDatesRequested: number;
  unsourceableCurrencies: string[];
  /** Per-currency missing dates (both failed and unsourceable) */
  missingDatesByCode: Record<string, string[]>;
}

// ---- Rate source cascade ----

/**
 * Sources that price in USD internally — querying them for "USD" is meaningless
 * since their prices are already denominated in USD.
 */
const USD_DENOMINATED_SOURCES: Set<SourceName> = new Set([
  "dprice", "defillama", "coingecko", "cryptocompare", "binance", "finnhub",
]);

/** Returns the ordered list of sources to try for a given asset type and currency. */
export function cascadeForType(assetType: string, config?: { disabledSources?: Set<string>; finnhubApiKey?: string; coingeckoApiKey?: string; cryptoCompareApiKey?: string }, currencyCode?: string): SourceName[] {
  const disabled = config?.disabledSources ?? new Set();
  const filter = (sources: SourceName[]) => sources.filter((s) => {
    if (disabled.has(s)) return false;
    if (s === "finnhub" && !config?.finnhubApiKey) return false;
    if (s === "coingecko" && !config?.coingeckoApiKey) return false;
    if (s === "cryptocompare" && !config?.cryptoCompareApiKey) return false;
    // Skip USD-denominated sources when the currency IS USD (can't price USD in USD)
    if (currencyCode === "USD" && USD_DENOMINATED_SOURCES.has(s)) return false;
    return true;
  });
  switch (assetType) {
    case "fiat": return filter(["dprice", "frankfurter"]);
    case "crypto": return filter(["dprice", "binance", "defillama", "coingecko", "cryptocompare"]);
    case "stock": return filter(["dprice", "finnhub"]);
    case "commodity": case "index": case "bond": return filter(["dprice"]);
    default: return filter(["dprice", "defillama", "binance", "coingecko"]); // unclassified
  }
}

/** Check if a source should be skipped due to recent failure (exponential backoff). */
function isFailureCached(currency: string, source: string, failureMap: Map<string, Map<string, RateFetchFailure>>): boolean {
  const bySource = failureMap.get(currency);
  if (!bySource) return false;
  const failure = bySource.get(source);
  if (!failure) return false;
  const backoffDays = Math.min(7 * Math.pow(2, failure.consecutive_failures - 1), 30);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - backoffDays);
  return new Date(failure.last_attempted_at) > cutoff;
}

function buildFailureMap(failures: RateFetchFailure[]): Map<string, Map<string, RateFetchFailure>> {
  const map = new Map<string, Map<string, RateFetchFailure>>();
  for (const f of failures) {
    let bySource = map.get(f.currency);
    if (!bySource) { bySource = new Map(); map.set(f.currency, bySource); }
    bySource.set(f.source, f);
  }
  return map;
}

export interface CascadeFetchResult extends HistoricalFetchResult {
  staleCurrencies: string[];
}

/**
 * Cascade rate fetcher: tries sources in priority order per asset type.
 * For each currency, tries sources in cascade order until all needed dates are filled
 * or all sources are exhausted.
 */
export async function cascadeFetchRates(
  backend: Backend,
  neededByCode: Map<string, string[]>,
  currencyTypes: Map<string, string>,
  config: HistoricalFetchConfig,
  overrides?: CurrencyRateOverride[],
  failures?: RateFetchFailure[],
): Promise<CascadeFetchResult> {
  const result: CascadeFetchResult = { fetched: 0, skipped: 0, errors: [], failedCurrencies: [], staleCurrencies: [] };
  if (neededByCode.size === 0) return result;

  const overrideMap = new Map<string, CurrencyRateOverride>();
  for (const o of overrides ?? []) overrideMap.set(o.currency, o);
  const failureMap = buildFailureMap(failures ?? []);

  // Track remaining currencies (those not yet fully served)
  const remainingCodes = new Set(neededByCode.keys());

  // Filter out overridden-to-none currencies upfront
  for (const code of [...remainingCodes]) {
    if (overrideMap.get(code)?.rate_source === "none") {
      remainingCodes.delete(code);
    }
  }

  // Group currencies by type for cascade ordering
  const typeGroups = new Map<string, string[]>();
  for (const code of remainingCodes) {
    const type = currencyTypes.get(code) ?? "";
    let group = typeGroups.get(type);
    if (!group) { group = []; typeGroups.set(type, group); }
    group.push(code);
  }

  // Process each type group through its cascade
  for (const [type, codes] of typeGroups) {
    const cascade = cascadeForType(type, config);
    if (cascade.length === 0) continue;

    // Track which currencies in this group still need rates
    const groupRemaining = new Set(codes);

    for (const source of cascade) {
      if (config.signal?.aborted) break;
      if (groupRemaining.size === 0) break;

      // Filter: skip failure-cached currencies and USD for USD-denominated sources
      const candidates = [...groupRemaining].filter(
        (c) => !isFailureCached(c, source, failureMap) &&
               !(c === "USD" && USD_DENOMINATED_SOURCES.has(source)),
      );
      if (candidates.length === 0) continue;

      // Build requests for this source
      const requests: HistoricalRateRequest[] = candidates
        .map((c) => ({ currency: c, dates: neededByCode.get(c)!, source }))
        .filter((r) => r.dates.length > 0);
      if (requests.length === 0) continue;

      // Dispatch to single source (skip internal fallbacks — we manage cascade externally)
      const sourceResult = await fetchHistoricalRates(backend, requests, { ...config, skipFallbacks: true });
      result.fetched += sourceResult.fetched;
      result.errors.push(...sourceResult.errors);

      // Track success/failure per currency
      const failedSet = new Set(sourceResult.failedCurrencies);
      for (const c of candidates) {
        if (failedSet.has(c)) {
          // Source returned nothing for this currency — record failure
          try { await backend.recordRateFetchFailure(c, source); } catch { /* ignore */ }
        } else {
          // Source succeeded — clear failure cache, mark as served
          try { await backend.clearRateFetchFailure(c, source); } catch { /* ignore */ }
          groupRemaining.delete(c);
          remainingCodes.delete(c);
        }
      }
    }
  }

  // ---- tracks_currency fallback: copy tracked currency's rates for unfilled currencies ----
  if (remainingCodes.size > 0) {
    // Load tracking relationships for remaining currencies
    const allCurrencies = await backend.listCurrencies();
    const trackingMap = new Map<string, string>();
    for (const c of allCurrencies) {
      if (c.tracks_currency && remainingCodes.has(c.code)) {
        trackingMap.set(c.code, c.tracks_currency);
      }
    }

    for (const [code, trackedCode] of trackingMap) {
      const dates = neededByCode.get(code);
      if (!dates || dates.length === 0) continue;

      // For each needed date, look up the tracked currency's rate and copy it
      let copiedCount = 0;
      for (const date of dates) {
        const trackedRate = await backend.getExchangeRate(trackedCode, config.baseCurrency, date);
        if (trackedRate) {
          try {
            await backend.recordExchangeRate({
              id: uuidv7(),
              date,
              from_currency: code,
              to_currency: config.baseCurrency,
              rate: trackedRate,
              source: `tracked:${trackedCode}`,
            });
            copiedCount++;
          } catch {
            // Rate may already exist (same date/pair)
          }
        }
      }
      if (copiedCount > 0) {
        remainingCodes.delete(code);
        result.fetched += copiedCount;
      }
    }
  }

  // Remaining currencies = unfilled after full cascade + tracking fallback
  result.failedCurrencies = [...remainingCodes];

  // Mark stale: currencies where all cascade sources exhausted and no rates for recent 30 days
  const today = new Date();
  for (const code of remainingCodes) {
    const dates = neededByCode.get(code) ?? [];
    const hasRecent = dates.some((d) => {
      const diff = (today.getTime() - new Date(d).getTime()) / 86400000;
      return diff <= 30;
    });
    if (hasRecent) {
      result.staleCurrencies.push(code);
      try { await backend.setCurrencyStale(code, true); } catch { /* ignore */ }
    }
  }

  return result;
}

/**
 * Automatically determine which exchange rates are missing across the entire ledger
 * and fetch them. Uses exact-date matching to find true gaps.
 */
export async function autoBackfillRates(
  backend: Backend,
  config: HistoricalFetchConfig,
  hiddenCurrencies: Set<string>,
  dpriceAssets?: Set<string>,
): Promise<AutoBackfillResult> {
  if (!backend.getCurrencyDateRequirements) {
    return { fetched: 0, skipped: 0, errors: ["Backend does not support getCurrencyDateRequirements"], failedCurrencies: [], unsourceableCurrencies: [], missingDatesByCode: {}, currenciesAnalyzed: 0, totalDatesRequested: 0 };
  }

  // Ensure the base currency exists in the database (may have been cleared by import/restore)
  await ensureCurrency(backend, config.baseCurrency);

  const requirements = await backend.getCurrencyDateRequirements(config.baseCurrency);

  // Filter out hidden currencies
  const filtered = requirements.filter((r) => !hiddenCurrencies.has(r.currency));

  // Build currency-date pairs
  const today = new Date().toISOString().slice(0, 10);
  const currencyDates: { currency: string; date: string }[] = [];

  for (const req of filtered) {
    if (req.mode === "range") {
      // Generate daily dates from firstDate to max(lastDate, today if hasBalance)
      const endDate = req.hasBalance && today > req.lastDate ? today : req.lastDate;
      let current = new Date(req.firstDate);
      const end = new Date(endDate);
      while (current <= end) {
        currencyDates.push({ currency: req.currency, date: current.toISOString().slice(0, 10) });
        current.setDate(current.getDate() + 1);
      }
    } else {
      // Use exact transaction dates
      for (const date of req.dates) {
        currencyDates.push({ currency: req.currency, date });
      }
    }
  }

  // When baseCurrency != "USD", ensure USD→baseCurrency rates are synced from Frankfurter.
  // Crypto sources (DefiLlama, dprice fallback) store rates as X→USD, so the transitive
  // lookup path X→USD→baseCurrency needs USD→baseCurrency in the exchange_rate table.
  if (config.baseCurrency !== "USD" && FRANKFURTER_FIAT.has(config.baseCurrency)) {
    const hasUsd = currencyDates.some((cd) => cd.currency === "USD");
    if (!hasUsd) {
      // Derive date range from non-fiat currency requirements
      let minDate = "9999-12-31";
      let maxDate = "0000-01-01";
      for (const req of filtered) {
        if (!FRANKFURTER_FIAT.has(req.currency)) {
          if (req.mode === "range") {
            if (req.firstDate < minDate) minDate = req.firstDate;
            const endDate = req.hasBalance && today > req.lastDate ? today : req.lastDate;
            if (endDate > maxDate) maxDate = endDate;
          } else {
            for (const d of req.dates) {
              if (d < minDate) minDate = d;
              if (d > maxDate) maxDate = d;
            }
          }
        }
      }
      // Fallback: if no non-fiat requirements, use ALL requirements (fiat-only ledger)
      if (minDate > maxDate) {
        for (const req of filtered) {
          if (req.mode === "range") {
            if (req.firstDate < minDate) minDate = req.firstDate;
            const endDate = req.hasBalance && today > req.lastDate ? today : req.lastDate;
            if (endDate > maxDate) maxDate = endDate;
          } else {
            for (const d of req.dates) {
              if (d < minDate) minDate = d;
              if (d > maxDate) maxDate = d;
            }
          }
        }
      }
      // Last resort: if ledger is empty, inject today for a current rate
      if (minDate > maxDate) {
        minDate = today;
        maxDate = today;
      }
      let current = new Date(minDate);
      const end = new Date(maxDate);
      while (current <= end) {
        currencyDates.push({ currency: "USD", date: current.toISOString().slice(0, 10) });
        current.setDate(current.getDate() + 1);
      }
    }

    // Auto-"none" clearing is no longer needed — the TTL failure cache auto-heals
  }

  // ---- Load shared reference data once (used by dprice resolution, findMissingRates, fetchHistoricalRates) ----
  const allCurrencies = await backend.listCurrencies();
  const currencyTypeMap = new Map(allCurrencies.map((c) => [c.code, c.asset_type]));
  const currencyNameMap = new Map(allCurrencies.map((c) => [c.code, c.name]));
  const tokenAddresses = await backend.getCurrencyTokenAddresses();
  const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));
  const tokenAddrCurrencies = new Set(tokenAddresses.map((t) => t.currency));

  // ---- Build dpriceAssets from overrides + discovery ----
  if (!dpriceAssets && isDpriceActive(config.dpriceMode)) {
    const overrides = await backend.getCurrencyRateOverrides();
    // Reconstruct dpriceAssets from currencies with dprice override
    dpriceAssets = new Set(
      overrides.filter(s => s.rate_source === "dprice").map(s => s.currency),
    );
    // USD is dprice's internal base unit — no fiat:USD asset exists. But when
    // baseCurrency != USD, we can derive USD rates via cross-rate (1 / base→USD).
    if (config.baseCurrency !== "USD") {
      dpriceAssets.add("USD");
    }

    // Query dprice for currencies not yet known to dprice
    const overrideSet = new Set(overrides.map(s => s.currency));
    const codes = [...new Set(currencyDates.map(cd => cd.currency))];
    const newCodes = codes.filter(c => !overrideSet.has(c) && !dpriceAssets!.has(c) && !FRANKFURTER_FIAT.has(c));

    if (newCodes.length > 0) {
      try {
        const client = createDpriceClient({ dpriceMode: config.dpriceMode, dpriceUrl: config.dpriceUrl });
        const entries = await client.getRates(newCodes);
        const discoveredCodes = new Set(entries.map(e => e.from));
        for (const code of discoveredCodes) {
          dpriceAssets.add(code);
        }

        // Batch-resolve dprice asset IDs for all new currencies
        const unresolvedCodes = newCodes.filter(c => !discoveredCodes.has(c) && c !== config.baseCurrency);
        const allCodesToResolve = [...discoveredCodes, ...unresolvedCodes];
        if (allCodesToResolve.length > 0) {
          const originChainMap = new Map<string, string>();
          if (backend.getCurrencyOrigins) {
            const origins = await backend.getCurrencyOrigins();
            for (const o of origins) {
              if (o.origin === "hyperliquid") originChainMap.set(o.currency, "hyperliquid");
              else if (o.origin === "solana") originChainMap.set(o.currency, "solana");
            }
          }
          const batchResults = await resolveDpriceAssetsBatch(client, allCodesToResolve.map(code => ({
            code,
            assetType: currencyTypeMap.get(code) ?? "",
            tokenAddr: tokenAddrMap.get(code),
            hints: { name: currencyNameMap.get(code), originChain: originChainMap.get(code) ?? tokenAddrMap.get(code)?.chain },
          })));
          for (const [code, resolved] of batchResults) {
            if (resolved !== "none" && resolved !== "ambiguous") {
              if (!discoveredCodes.has(code)) dpriceAssets.add(code);
            }
          }
        }
      } catch {
        // dprice unavailable — proceed with DB-known dprice currencies only
      }
    }

  }

  const totalDatesRequested = currencyDates.length;

  if (currencyDates.length === 0) {
    return { fetched: 0, skipped: 0, errors: [], failedCurrencies: [], unsourceableCurrencies: [], missingDatesByCode: {}, currenciesAnalyzed: filtered.length, totalDatesRequested: 0 };
  }

  // Load overrides and failures for cascade runner
  const overrides = await backend.getCurrencyRateOverrides();
  const failures = await backend.getRateFetchFailures();

  // Build needed dates per currency, checking which dates already have rates
  const neededByCode = new Map<string, string[]>();
  const datesByCurrency = new Map<string, Set<string>>();
  for (const cd of currencyDates) {
    if (cd.currency === config.baseCurrency) continue;
    let dates = datesByCurrency.get(cd.currency);
    if (!dates) { dates = new Set(); datesByCurrency.set(cd.currency, dates); }
    dates.add(cd.date);
  }

  // Check which dates already have rates (batch exact check)
  if (backend.getExchangeRatesBatchExact) {
    const allPairs = [...datesByCurrency.entries()].flatMap(([currency, dates]) =>
      [...dates].map((date) => ({ currency, date })),
    );
    if (allPairs.length > 0) {
      const existing = await backend.getExchangeRatesBatchExact(allPairs, config.baseCurrency);
      for (const [key, exists] of existing) {
        if (exists) {
          const [currency, date] = key.split(":");
          datesByCurrency.get(currency)?.delete(date);
        }
      }
    }
  }

  for (const [currency, dates] of datesByCurrency) {
    if (dates.size > 0) {
      neededByCode.set(currency, [...dates].sort());
    }
  }

  const missingDatesByCode: Record<string, string[]> = {};

  if (neededByCode.size === 0) {
    return { fetched: 0, skipped: 0, errors: [], failedCurrencies: [], unsourceableCurrencies: [], missingDatesByCode, currenciesAnalyzed: filtered.length, totalDatesRequested };
  }

  // Run cascade fetcher
  const cascadeResult = await cascadeFetchRates(backend, neededByCode, currencyTypeMap, config, overrides, failures);

  // Collect per-currency missing dates for failed currencies
  for (const code of cascadeResult.failedCurrencies) {
    const dates = neededByCode.get(code);
    if (dates) missingDatesByCode[code] = dates;
  }

  return {
    fetched: cascadeResult.fetched,
    skipped: cascadeResult.skipped,
    errors: cascadeResult.errors,
    failedCurrencies: cascadeResult.failedCurrencies,
    unsourceableCurrencies: [],
    missingDatesByCode,
    currenciesAnalyzed: filtered.length,
    totalDatesRequested,
  };
}

/**
 * Enqueue a rate backfill task into the task queue.
 *
 * Two modes:
 * - With `currencyDates`: targeted backfill for specific currency/date pairs (CSV/OFX/PDF/Ledger imports)
 * - Without `currencyDates`: full ledger analysis via autoBackfillRates (Etherscan/CEX sync, Sources button)
 */
export function enqueueRateBackfill(
  taskQueue: { enqueue(def: import("./task-queue.svelte.js").TaskDefinition): void; isActive(key: string): boolean },
  backend: Backend,
  config: HistoricalFetchConfig,
  hiddenCurrencies: Set<string>,
  currencyDates?: [string, string][],
  dpriceAssets?: Set<string>,
): void {
  // Skip if a backfill is already running
  if (taskQueue.isActive("rate-backfill")) return;

  if (currencyDates && currencyDates.length > 0) {
    // Targeted backfill for specific import
    const pairs = currencyDates.map(([currency, date]) => ({ currency, date }));
    taskQueue.enqueue({
      key: "rate-backfill:post-import",
      label: m.task_rate_backfill_import({ count: String(new Set(currencyDates.map(([c]) => c)).size) }),
      async run(ctx) {
        // Auto-resolve dpriceAssets when dprice is active but caller didn't provide the set
        const resolvedDpriceAssets = dpriceAssets ?? await resolveDpriceAssets(config, [...new Set(pairs.map((p) => p.currency))]);
        const missing = await findMissingRates(backend, config.baseCurrency, pairs, resolvedDpriceAssets, undefined, config.disabledSources);
        if (missing.length === 0) {
          return { summary: m.task_rates_already_available() };
        }
        const totalDates = missing.reduce((sum, r) => sum + r.dates.length, 0);
        const result = await fetchHistoricalRates(backend, missing, {
          ...config,
          signal: ctx.signal,
          onProgress: (fetched, total) => ctx.reportProgress({ current: fetched, total: total || totalDates }),
        }, resolvedDpriceAssets);
        return { summary: m.task_rate_fetched_summary({ count: String(result.fetched) }), data: result };
      },
    });
  } else {
    // Full auto-backfill
    taskQueue.enqueue({
      key: "rate-backfill:auto",
      label: m.task_rate_backfill_auto(),
      async run(ctx) {
        setRateHealthSyncing();
        const result = await autoBackfillRates(backend, {
          ...config,
          signal: ctx.signal,
          onProgress: (fetched, total) => ctx.reportProgress({ current: fetched, total }),
        }, hiddenCurrencies, dpriceAssets);

        // Failures are now handled by rate_fetch_failure TTL cache (no more auto-"none" marking)

        // Update rate health store — report both failed and unsourceable (non-hidden) currencies
        const allMissing = [...new Set([...result.failedCurrencies, ...result.unsourceableCurrencies])];
        const failedNonHidden = allMissing.filter(
          (c) => !hiddenCurrencies.has(c),
        );
        updateRateHealth(result, failedNonHidden);

        if (result.fetched === 0 && result.errors.length === 0) {
          return { summary: m.task_rates_already_available() };
        }
        return {
          summary: m.task_rate_fetched_full_summary({ fetched: String(result.fetched), currencies: String(result.currenciesAnalyzed) }),
          data: result,
        };
      },
    });
  }
}

// ---- Helpers ----

const knownCurrencies = new Set<string>();

async function ensureCurrency(backend: Backend, code: string): Promise<void> {
  if (knownCurrencies.has(code)) return;
  try {
    await backend.createCurrency({
      code,
      asset_type: FRANKFURTER_FIAT.has(code) ? "fiat" : "",
      name: code,
      decimal_places: code.length <= 3 ? 2 : 8,
    });
  } catch {
    // Already exists — expected
  }
  knownCurrencies.add(code);
}

async function recordRate(
  backend: Backend,
  fromCurrency: string,
  toCurrency: string,
  date: string,
  rate: number,
  source: string,
  result: HistoricalFetchResult,
): Promise<void> {
  await ensureCurrency(backend, fromCurrency);
  await ensureCurrency(backend, toCurrency);
  await backend.recordExchangeRate({
    id: uuidv7(),
    date,
    from_currency: fromCurrency,
    to_currency: toCurrency,
    rate: rate.toString(),
    source,
  });
  result.fetched++;
}

function chunkDateRange(start: string, end: string, maxDays: number): [string, string][] {
  const chunks: [string, string][] = [];
  let current = new Date(start);
  const endDate = new Date(end);
  while (current <= endDate) {
    const chunkEnd = new Date(current);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    chunks.push([current.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }
  return chunks;
}

function findNearestPrice(dateMap: Map<string, number>, targetDate: string, maxDaysAway: number): number | null {
  const target = new Date(targetDate);
  for (let delta = 1; delta <= maxDaysAway; delta++) {
    for (const sign of [-1, 1]) {
      const d = new Date(target);
      d.setDate(d.getDate() + delta * sign);
      const key = d.toISOString().slice(0, 10);
      const price = dateMap.get(key);
      if (price != null) return price;
    }
  }
  return null;
}
