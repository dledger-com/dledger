import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateSource } from "./backend.js";
import type { SourceName } from "./exchange-rate-sync.js";

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
): SourceName | null {
  // 1. DB-stored source always wins
  const stored = rateSourceMap.get(currency);
  if (stored?.rate_source === "none") return null;
  if (stored?.rate_source) {
    return stored.rate_source as SourceName;
  }
  // 2. Static heuristic fallback
  if (FRANKFURTER_FIAT.has(currency) && FRANKFURTER_FIAT.has(baseCurrency)) return "frankfurter";
  if (COINGECKO_IDS[currency]) return "coingecko";
  return "coingecko";
}

// ---- Find missing rates ----

export async function findMissingRates(
  backend: Backend,
  baseCurrency: string,
  currencyDates: { currency: string; date: string }[],
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

  // Check which rates are missing — batch if available
  const missing = new Map<string, { currency: string; dates: string[]; source: SourceName }>();

  if (backend.getExchangeRatesBatch && unique.length > 0) {
    const existenceMap = await backend.getExchangeRatesBatch(unique, baseCurrency);
    for (const { currency, date } of unique) {
      const key = `${currency}:${date}`;
      if (existenceMap.get(key)) continue;

      const source = classifySource(currency, baseCurrency, rateSourceMap);
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

      const source = classifySource(currency, baseCurrency, rateSourceMap);
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

  // ---- Frankfurter: full timeseries, multi-symbol ----
  if (frankfurterReqs.length > 0) {
    await fetchFrankfurterHistorical(backend, frankfurterReqs, config, result, successCurrencies, () => {
      progress++;
      config.onProgress?.(progress, totalDates);
    });
  }

  // ---- CoinGecko: market_chart/range per coin ----
  if (coingeckoReqs.length > 0) {
    if (!config.coingeckoApiKey) {
      result.errors.push(`CoinGecko: no API key; skipping ${coingeckoReqs.length} currency(ies)`);
    } else {
      await fetchCoinGeckoHistorical(backend, coingeckoReqs, config, result, successCurrencies, () => {
        progress++;
        config.onProgress?.(progress, totalDates);
      });
    }
  }

  // ---- Finnhub: candle per symbol ----
  if (finnhubReqs.length > 0) {
    if (!config.finnhubApiKey) {
      result.errors.push(`Finnhub: no API key; skipping ${finnhubReqs.length} currency(ies)`);
    } else {
      await fetchFinnhubHistorical(backend, finnhubReqs, config, result, successCurrencies, () => {
        progress++;
        config.onProgress?.(progress, totalDates);
      });
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
