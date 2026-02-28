import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateSource } from "./backend.js";
import type { SourceName } from "./exchange-rate-sync.js";
import { createDpriceClient } from "./dprice-client.js";
import { isDpriceActive, type DpriceMode } from "./data/settings.svelte.js";

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
  finnhubApiKey: string;
  cryptoCompareApiKey?: string;
  dpriceMode?: DpriceMode;
  dpriceUrl?: string;
  onProgress?: (fetched: number, total: number) => void;
}

export interface HistoricalFetchResult {
  fetched: number;
  skipped: number;
  errors: string[];
  failedCurrencies: string[];
}

// ---- Source classification ----

function classifySource(
  currency: string,
  baseCurrency: string,
  rateSourceMap: Map<string, CurrencyRateSource>,
  tokenAddressCurrencies?: Set<string>,
  dpriceAssets?: Set<string>,
): SourceName | null {
  // 1. DB-stored source always wins
  const stored = rateSourceMap.get(currency);
  if (stored?.rate_source === "none") return null;
  if (stored?.rate_source) {
    return stored.rate_source as SourceName;
  }
  // 2. When dprice is enabled and asset is available, prefer it
  if (dpriceAssets?.has(currency)) return "dprice";
  // 3. Static heuristic fallback
  if (FRANKFURTER_FIAT.has(currency) && FRANKFURTER_FIAT.has(baseCurrency)) return "frankfurter";
  if (tokenAddressCurrencies?.has(currency)) return "defillama";
  if (COINGECKO_IDS[currency]) return "defillama";
  return null; // No known pricing path — skip
}

// ---- Find missing rates ----

export async function findMissingRates(
  backend: Backend,
  baseCurrency: string,
  currencyDates: { currency: string; date: string }[],
  dpriceAssets?: Set<string>,
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

  // Load DB-stored rate sources
  const storedSources = await backend.getCurrencyRateSources();
  const rateSourceMap = new Map<string, CurrencyRateSource>();
  for (const src of storedSources) {
    rateSourceMap.set(src.currency, src);
  }

  // Load token addresses for source classification
  const tokenAddresses = await backend.getCurrencyTokenAddresses();
  const tokenAddrCurrencies = new Set(tokenAddresses.map((t) => t.currency));

  // Check which rates are missing — batch if available
  const missing = new Map<string, { currency: string; dates: string[]; source: SourceName }>();

  if (backend.getExchangeRatesBatch && unique.length > 0) {
    const existenceMap = await backend.getExchangeRatesBatch(unique, baseCurrency);
    for (const { currency, date } of unique) {
      const key = `${currency}:${date}`;
      if (existenceMap.get(key)) continue;

      const source = classifySource(currency, baseCurrency, rateSourceMap, tokenAddrCurrencies, dpriceAssets);
      if (!source) continue;  // rate_source = "none" → skip
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

      const source = classifySource(currency, baseCurrency, rateSourceMap, tokenAddrCurrencies, dpriceAssets);
      if (!source) continue;  // rate_source = "none" → skip
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

  // ---- Frankfurter: full timeseries, multi-symbol ----
  if (frankfurterReqs.length > 0) {
    await fetchFrankfurterHistorical(backend, frankfurterReqs, config, result, successCurrencies, tick);
  }

  // ---- CoinGecko: market_chart/range per coin ----
  if (coingeckoReqs.length > 0) {
    if (!config.coingeckoApiKey) {
      result.errors.push(`CoinGecko: no API key; skipping ${coingeckoReqs.length} currency(ies)`);
    } else {
      await fetchCoinGeckoHistorical(backend, coingeckoReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- Finnhub: candle per symbol ----
  if (finnhubReqs.length > 0) {
    if (!config.finnhubApiKey) {
      result.errors.push(`Finnhub: no API key; skipping ${finnhubReqs.length} currency(ies)`);
    } else {
      await fetchFinnhubHistorical(backend, finnhubReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- DefiLlama: batch historical ----
  if (defillamaReqs.length > 0) {
    await fetchDefiLlamaHistorical(backend, defillamaReqs, config, result, successCurrencies, tick);
  }

  // ---- CryptoCompare: histoday per symbol ----
  if (cryptocompareReqs.length > 0) {
    if (!config.cryptoCompareApiKey) {
      result.errors.push(`CryptoCompare: no API key; skipping ${cryptocompareReqs.length} currency(ies)`);
    } else {
      await fetchCryptoCompareHistorical(backend, cryptocompareReqs, config, result, successCurrencies, tick);
    }
  }

  // ---- Binance: klines per symbol ----
  if (binanceReqs.length > 0) {
    await fetchBinanceHistorical(backend, binanceReqs, config, result, successCurrencies, tick);
  }

  // ---- dprice: local price DB historical ----
  if (dpriceReqs.length > 0 && isDpriceActive(config.dpriceMode)) {
    await fetchDpriceHistorical(backend, dpriceReqs, config, result, successCurrencies, tick);
  }

  // Fallback chain: if DefiLlama failed for some currencies, try CoinGecko → CryptoCompare
  const failedAfterPrimary = new Set<string>();
  for (const currency of allCurrencies) {
    if (!successCurrencies.has(currency)) {
      failedAfterPrimary.add(currency);
    }
  }

  if (failedAfterPrimary.size > 0 && config.coingeckoApiKey) {
    const fallbackReqs = requests
      .filter((r) => failedAfterPrimary.has(r.currency) && r.source === "defillama")
      .map((r) => ({ ...r, source: "coingecko" as SourceName }));
    if (fallbackReqs.length > 0) {
      await fetchCoinGeckoHistorical(backend, fallbackReqs, config, result, successCurrencies, tick);
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
    try {
      const url = `https://api.frankfurter.dev/v1/${chunkStart}..${chunkEnd}?base=${config.baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
        continue;
      }
      const data: FrankfurterTimeseriesResponse = await resp.json();

      for (const [date, rates] of Object.entries(data.rates)) {
        for (const [code, rateValue] of Object.entries(rates)) {
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
          const key = `${code}:${date}`;
          if (neededSet.has(key)) {
            neededSet.delete(key);
            onDateDone();
          }
        }
      }
    } catch (err) {
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
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];
  try {
    for (const req of requests) {
      const geckoId = COINGECKO_IDS[req.currency] ?? req.currency.toLowerCase();
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      const fromUnix = Math.floor(new Date(sortedDates[0]).getTime() / 1000) - 86400;
      const toUnix = Math.floor(new Date(sortedDates[sortedDates.length - 1]).getTime() / 1000) + 86400;
      const vsBase = config.baseCurrency.toLowerCase();

      try {
        const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart/range?vs_currency=${vsBase}&from=${fromUnix}&to=${toUnix}&x_cg_demo_api_key=${config.coingeckoApiKey}`;
        const resp = await geckoFetch.fetch(url);
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
        result.errors.push(`CoinGecko ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
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
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];
  try {
    for (const req of requests) {
      const sortedDates = [...req.dates].sort();
      const neededDates = new Set(sortedDates);

      const fromUnix = Math.floor(new Date(sortedDates[0]).getTime() / 1000) - 86400;
      const toUnix = Math.floor(new Date(sortedDates[sortedDates.length - 1]).getTime() / 1000) + 86400;

      try {
        const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(req.currency)}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${config.finnhubApiKey}`;
        const resp = await finnhubFetch.fetch(url);
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
        result.errors.push(`Finnhub ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
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
      const timestamp = Math.floor(new Date(date + "T12:00:00Z").getTime() / 1000);
      const coinList = [...coinSet].join(",");
      const url = `https://coins.llama.fi/prices/historical/${timestamp}/${coinList}?searchWidth=21600`;

      try {
        const resp = await llamaFetch.fetch(url);
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
        result.errors.push(`DefiLlama date ${date}: ${err instanceof Error ? err.message : String(err)}`);
        for (const _c of coinSet) onDateDone();
      }
    }
  } finally {
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
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  try {
    for (const req of requests) {
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
        const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${req.currency}&tsym=${config.baseCurrency}&limit=${limit}&toTs=${toTs}&api_key=${config.cryptoCompareApiKey}`;
        const resp = await ccFetch.fetch(url);
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
        result.errors.push(`CryptoCompare ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
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
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  const quoteMap: Record<string, string> = { USD: "USDT", EUR: "EUR" };
  const quote = quoteMap[config.baseCurrency] ?? config.baseCurrency;

  try {
    for (const req of requests) {
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
          const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${cStart}&endTime=${cEnd}&limit=1000`;
          const resp = await binanceFetch.fetch(url);
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
        result.errors.push(`Binance ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
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

async function fetchDpriceHistorical(
  backend: Backend,
  requests: HistoricalRateRequest[],
  config: HistoricalFetchConfig,
  result: HistoricalFetchResult,
  successCurrencies: Set<string>,
  onDateDone: () => void,
): Promise<void> {
  const client = createDpriceClient({ dpriceMode: config.dpriceMode, dpriceUrl: config.dpriceUrl });
  const rateBatch: import("./types/index.js").ExchangeRate[] = [];

  for (const req of requests) {
    const sortedDates = [...req.dates].sort();
    if (sortedDates.length === 0) continue;

    const fromDate = sortedDates[0];
    const toDate = sortedDates[sortedDates.length - 1];

    try {
      // Fetch USD prices in bulk from dprice
      const prices = await client.getPriceRange(req.currency, fromDate, toDate);
      const dateMap = new Map(prices.map((p) => [p.date, p.price_usd]));

      // If baseCurrency is not USD, also fetch baseCurrency USD price for cross-rate
      let basePriceMap: Map<string, string> | null = null;
      if (config.baseCurrency !== "USD") {
        const basePrices = await client.getPriceRange(config.baseCurrency, fromDate, toDate);
        basePriceMap = new Map(basePrices.map((p) => [p.date, p.price_usd]));
      }

      await ensureCurrency(backend, req.currency);
      await ensureCurrency(backend, config.baseCurrency);

      for (const date of sortedDates) {
        const usdPrice = dateMap.get(date);
        if (usdPrice == null) {
          result.skipped++;
          onDateDone();
          continue;
        }

        let finalRate: string;
        let toCurrency: string;
        if (basePriceMap) {
          // Cross-rate: asset_USD / base_USD
          const baseUsd = basePriceMap.get(date);
          if (baseUsd == null || parseFloat(baseUsd) === 0) {
            result.skipped++;
            onDateDone();
            continue;
          }
          finalRate = (parseFloat(usdPrice) / parseFloat(baseUsd)).toString();
          toCurrency = config.baseCurrency;
        } else {
          finalRate = usdPrice;
          toCurrency = "USD";
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
    } catch (err) {
      result.errors.push(`dprice ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
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

  const missing = await findMissingRates(backend, config.baseCurrency, targets);
  if (missing.length === 0) return { fetched: 0, skipped: 0, errors: [], failedCurrencies: [] };

  return fetchHistoricalRates(backend, missing, config);
}

// ---- Helpers ----

const knownCurrencies = new Set<string>();

async function ensureCurrency(backend: Backend, code: string): Promise<void> {
  if (knownCurrencies.has(code)) return;
  try {
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: code.length <= 3 ? 2 : 8,
      is_base: false,
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
