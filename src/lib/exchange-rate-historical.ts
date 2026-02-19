import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend } from "./backend.js";
import type { RateSourceInfo } from "./data/settings.svelte.js";
import type { SourceName } from "./exchange-rate-sync.js";
import type { CurrencyContextMap } from "./currency-context.js";

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
}

// ---- Source classification ----

function classifySource(
  currency: string,
  baseCurrency: string,
  rateSources: Record<string, RateSourceInfo>,
  currencyContext?: CurrencyContextMap,
): SourceName {
  // 1. User preference always wins
  const info = rateSources[currency];
  if (info?.preferred) return info.preferred as SourceName;
  // 2. Check context map before falling back to static heuristic
  if (currencyContext) {
    const ctx = currencyContext.get(currency);
    if (ctx && ctx.recommendedSources.length > 0) {
      return ctx.recommendedSources[0];
    }
  }
  // 3. Static heuristic fallback
  if (FRANKFURTER_FIAT.has(currency) && FRANKFURTER_FIAT.has(baseCurrency)) return "frankfurter";
  if (COINGECKO_IDS[currency]) return "coingecko";
  return "finnhub";
}

// ---- Find missing rates ----

export async function findMissingRates(
  backend: Backend,
  baseCurrency: string,
  currencyDates: { currency: string; date: string }[],
  rateSources: Record<string, RateSourceInfo>,
  currencyContext?: CurrencyContextMap,
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

  // Check which rates are missing
  const missing = new Map<string, { currency: string; dates: string[]; source: SourceName }>();

  for (const { currency, date } of unique) {
    const rate = await backend.getExchangeRate(currency, baseCurrency, date);
    if (rate !== null) continue;

    const source = classifySource(currency, baseCurrency, rateSources, currencyContext);
    const key = `${currency}:${source}`;
    if (!missing.has(key)) {
      missing.set(key, { currency, dates: [], source });
    }
    missing.get(key)!.dates.push(date);
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
  const result: HistoricalFetchResult = { fetched: 0, skipped: 0, errors: [] };
  const totalDates = requests.reduce((sum, r) => sum + r.dates.length, 0);
  let progress = 0;

  // Group requests by source
  const frankfurterReqs = requests.filter((r) => r.source === "frankfurter");
  const coingeckoReqs = requests.filter((r) => r.source === "coingecko");
  const finnhubReqs = requests.filter((r) => r.source === "finnhub");

  // ---- Frankfurter: full timeseries, multi-symbol ----
  if (frankfurterReqs.length > 0) {
    await fetchFrankfurterHistorical(backend, frankfurterReqs, config, result, () => {
      progress++;
      config.onProgress?.(progress, totalDates);
    });
  }

  // ---- CoinGecko: market_chart/range per coin ----
  if (coingeckoReqs.length > 0) {
    if (!config.coingeckoApiKey) {
      result.errors.push(`CoinGecko: no API key; skipping ${coingeckoReqs.length} currency(ies)`);
    } else {
      await fetchCoinGeckoHistorical(backend, coingeckoReqs, config, result, () => {
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
      await fetchFinnhubHistorical(backend, finnhubReqs, config, result, () => {
        progress++;
        config.onProgress?.(progress, totalDates);
      });
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
          const key = `${code}:${date}`;
          if (!neededSet.has(key)) {
            // Store all rates we get (free data), but only count needed ones
            await recordRate(backend, code, config.baseCurrency, date, 1 / rateValue, "frankfurter", result);
            continue;
          }
          neededSet.delete(key);
          const invertedRate = 1 / rateValue;
          await recordRate(backend, code, config.baseCurrency, date, invertedRate, "frankfurter", result);
          onDateDone();
        }
      }
    } catch (err) {
      result.errors.push(`Frankfurter: ${err instanceof Error ? err.message : String(err)}`);
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
  onDateDone: () => void,
): Promise<void> {
  const geckoFetch = new RateLimitedFetcher({ maxRequests: 25, intervalMs: 60_000 });
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

        for (const date of neededDates) {
          const price = dateMap.get(date);
          if (price != null) {
            await recordRate(backend, req.currency, config.baseCurrency, date, price, "coingecko", result);
            onDateDone();
          } else {
            // Try nearest date within ±1 day
            const nearby = findNearestPrice(dateMap, date, 1);
            if (nearby !== null) {
              await recordRate(backend, req.currency, config.baseCurrency, date, nearby, "coingecko", result);
              onDateDone();
            } else {
              result.skipped++;
              onDateDone();
            }
          }
        }
      } catch (err) {
        result.errors.push(`CoinGecko ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    geckoFetch.dispose();
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
  onDateDone: () => void,
): Promise<void> {
  const finnhubFetch = new RateLimitedFetcher({ maxRequests: 50, intervalMs: 60_000 });
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
        for (const date of neededDates) {
          const price = dateMap.get(date);
          if (price != null) {
            await recordRate(backend, req.currency, toCurrency, date, price, "finnhub", result);
            onDateDone();
          } else {
            // Try nearest trading day within ±3 days
            const nearby = findNearestPrice(dateMap, date, 3);
            if (nearby !== null) {
              await recordRate(backend, req.currency, toCurrency, date, nearby, "finnhub", result);
              onDateDone();
            } else {
              result.skipped++;
              onDateDone();
            }
          }
        }
      } catch (err) {
        result.errors.push(`Finnhub ${req.currency}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    finnhubFetch.dispose();
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
  rateSources: Record<string, RateSourceInfo>,
  currencyContext?: CurrencyContextMap,
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

  const missing = await findMissingRates(backend, config.baseCurrency, targets, rateSources, currencyContext);
  if (missing.length === 0) return { fetched: 0, skipped: 0, errors: [] };

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
