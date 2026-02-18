import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend } from "./backend.js";
import type { RateSourceInfo } from "./data/settings.svelte.js";

// ECB/Frankfurter supported fiat currency codes
const FRANKFURTER_FIAT = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

// Common crypto ticker → CoinGecko ID mapping
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  POL: "matic-network",
  LINK: "chainlink",
  UNI: "uniswap",
  ATOM: "cosmos",
  LTC: "litecoin",
  NEAR: "near",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  FIL: "filecoin",
  AAVE: "aave",
  MKR: "maker",
  SNX: "havven",
  COMP: "compound-governance-token",
  CRV: "curve-dao-token",
  SHIB: "shiba-inu",
  PEPE: "pepe",
  SUI: "sui",
  SEI: "sei-network",
  TIA: "celestia",
  USDT: "tether",
  USDC: "usd-coin",
  DAI: "dai",
};

export interface ExchangeRateSyncResult {
  rates_fetched: number;
  rates_skipped: number;
  errors: string[];
  pendingChoices: { currency: string; sources: string[] }[];
  updatedRateSources: Record<string, RateSourceInfo>;
  updatedInitializedSources: string[];
}

interface FrankfurterResponse {
  date: string;
  rates: Record<string, number>;
}

interface CoinGeckoResponse {
  [id: string]: { [vsCurrency: string]: number };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export type SourceName = "frankfurter" | "coingecko" | "finnhub";

function applicableSources(code: string, baseCurrency: string): SourceName[] {
  const sources: SourceName[] = [];
  if (FRANKFURTER_FIAT.has(code) && FRANKFURTER_FIAT.has(baseCurrency)) {
    sources.push("frankfurter");
  }
  if (!FRANKFURTER_FIAT.has(code)) {
    sources.push("coingecko");
    sources.push("finnhub");
  }
  return sources;
}

export async function syncExchangeRates(
  backend: Backend,
  baseCurrency: string,
  coingeckoApiKey: string,
  finnhubApiKey: string,
  hiddenCurrencies: Set<string>,
  rateSources: Record<string, RateSourceInfo>,
  initializedRateSources: string[],
): Promise<ExchangeRateSyncResult> {
  const result: ExchangeRateSyncResult = {
    rates_fetched: 0,
    rates_skipped: 0,
    errors: [],
    pendingChoices: [],
    updatedRateSources: JSON.parse(JSON.stringify(rateSources)),
    updatedInitializedSources: [...initializedRateSources],
  };

  const today = todayISO();
  const currencies = await backend.listCurrencies();
  const codes = currencies
    .map((c) => c.code)
    .filter((c) => c !== baseCurrency && !hiddenCurrencies.has(c));

  if (codes.length === 0) return result;

  const initializedSet = new Set(initializedRateSources);

  // Determine which services are newly available (not yet initialized)
  const newServices = new Set<SourceName>();
  if (!initializedSet.has("frankfurter")) newServices.add("frankfurter");
  if (coingeckoApiKey && !initializedSet.has("coingecko")) newServices.add("coingecko");
  if (finnhubApiKey && !initializedSet.has("finnhub")) newServices.add("finnhub");

  // Phase 1: Build per-currency fetch plan
  // For each currency, determine which sources to fetch from and whether to skip existing rates
  const frankfurterCodes: { code: string; discovery: boolean }[] = [];
  const coingeckoCodes: { code: string; discovery: boolean }[] = [];
  const finnhubCodes: { code: string; discovery: boolean }[] = [];

  // Track which currencies succeeded on which source
  const successMap = new Map<string, Set<string>>();

  for (const code of codes) {
    const info = result.updatedRateSources[code];
    const preferred = info?.preferred || "";
    const applicable = applicableSources(code, baseCurrency);

    if (preferred) {
      // Has preference: only fetch from preferred source
      if (applicable.includes(preferred as SourceName)) {
        const entry = { code, discovery: false };
        if (preferred === "frankfurter") frankfurterCodes.push(entry);
        else if (preferred === "coingecko") coingeckoCodes.push(entry);
        else if (preferred === "finnhub") finnhubCodes.push(entry);
      }
      // Also check if any new service applies to this currency (discovery for new services)
      for (const svc of newServices) {
        if (applicable.includes(svc) && svc !== preferred) {
          const entry = { code, discovery: true };
          if (svc === "frankfurter") frankfurterCodes.push(entry);
          else if (svc === "coingecko") coingeckoCodes.push(entry);
          else if (svc === "finnhub") finnhubCodes.push(entry);
        }
      }
    } else {
      // No preference: discovery mode — try all applicable sources
      for (const svc of applicable) {
        const entry = { code, discovery: true };
        if (svc === "frankfurter") frankfurterCodes.push(entry);
        else if (svc === "coingecko") coingeckoCodes.push(entry);
        else if (svc === "finnhub") finnhubCodes.push(entry);
      }
    }
  }

  function trackSuccess(code: string, source: string) {
    let set = successMap.get(code);
    if (!set) {
      set = new Set();
      successMap.set(code, set);
    }
    set.add(source);
  }

  // Phase 2: Execute fetches

  // ---- Fiat rates via Frankfurter ----
  if (frankfurterCodes.length > 0) {
    const uniqueCodes = [...new Set(frankfurterCodes.map((e) => e.code))];
    const discoverySet = new Set(frankfurterCodes.filter((e) => e.discovery).map((e) => e.code));
    try {
      const symbols = uniqueCodes.join(",");
      const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
      } else {
        const data: FrankfurterResponse = await resp.json();
        for (const code of uniqueCodes) {
          const rateValue = data.rates[code];
          if (rateValue == null) {
            result.errors.push(`Frankfurter: no rate for ${code}`);
            continue;
          }

          trackSuccess(code, "frankfurter");

          // Skip recording if rate exists today and this is a non-discovery fetch
          // For discovery fetches, we still record if the preferred source differs
          const existing = await backend.getExchangeRate(code, baseCurrency, today);
          if (existing !== null && !discoverySet.has(code)) {
            result.rates_skipped++;
            continue;
          }

          // For discovery: only record if this is the preferred source or no rate exists yet
          const info = result.updatedRateSources[code];
          if (existing !== null && info?.preferred && info.preferred !== "frankfurter") {
            // Rate exists from preferred source; just note availability
            continue;
          }

          const invertedRate = 1 / rateValue;
          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: baseCurrency,
            rate: invertedRate.toString(),
            source: "frankfurter",
          });
          result.rates_fetched++;
        }
      }
    } catch (err) {
      result.errors.push(`Frankfurter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Crypto rates via CoinGecko ----
  if (coingeckoCodes.length > 0) {
    if (!coingeckoApiKey) {
      result.errors.push(
        `CoinGecko: no API key provided; skipping ${coingeckoCodes.length} crypto rate(s)`,
      );
    } else {
      const uniqueCodes = [...new Set(coingeckoCodes.map((e) => e.code))];
      const discoverySet = new Set(coingeckoCodes.filter((e) => e.discovery).map((e) => e.code));
      const geckoFetch = new RateLimitedFetcher({ maxRequests: 30, intervalMs: 60_000 });
      try {
        const idMap = new Map<string, string>(); // geckoId → ticker
        const geckoIds: string[] = [];
        for (const code of uniqueCodes) {
          const geckoId = COINGECKO_IDS[code] ?? code.toLowerCase();
          idMap.set(geckoId, code);
          geckoIds.push(geckoId);
        }

        const ids = geckoIds.join(",");
        const vsBase = baseCurrency.toLowerCase();
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vsBase}&x_cg_demo_api_key=${coingeckoApiKey}`;
        const resp = await geckoFetch.fetch(url);

        if (!resp.ok) {
          result.errors.push(`CoinGecko HTTP ${resp.status}: ${resp.statusText}`);
        } else {
          const data: CoinGeckoResponse = await resp.json();
          for (const [geckoId, ticker] of idMap) {
            const priceData = data[geckoId];
            if (!priceData || priceData[vsBase] == null) {
              result.errors.push(`CoinGecko: no rate for ${ticker} (id: ${geckoId})`);
              continue;
            }

            trackSuccess(ticker, "coingecko");

            const existing = await backend.getExchangeRate(ticker, baseCurrency, today);
            if (existing !== null && !discoverySet.has(ticker)) {
              result.rates_skipped++;
              continue;
            }

            const info = result.updatedRateSources[ticker];
            if (existing !== null && info?.preferred && info.preferred !== "coingecko") {
              continue;
            }

            const rate = priceData[vsBase];
            await backend.recordExchangeRate({
              id: uuidv7(),
              date: today,
              from_currency: ticker,
              to_currency: baseCurrency,
              rate: rate.toString(),
              source: "coingecko",
            });
            result.rates_fetched++;
          }
        }
      } catch (err) {
        result.errors.push(`CoinGecko: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        geckoFetch.dispose();
      }
    }
  }

  // ---- Stock prices via Finnhub ----
  if (finnhubCodes.length > 0) {
    if (!finnhubApiKey) {
      result.errors.push(
        `Finnhub: no API key provided; skipping ${finnhubCodes.length} stock price(s)`,
      );
    } else {
      const uniqueCodes = [...new Set(finnhubCodes.map((e) => e.code))];
      const discoverySet = new Set(finnhubCodes.filter((e) => e.discovery).map((e) => e.code));
      const finnhubFetch = new RateLimitedFetcher({ maxRequests: 55, intervalMs: 60_000 });
      try {
        for (const code of uniqueCodes) {
          const existing = await backend.getExchangeRate(code, "USD", today);
          if (existing !== null && !discoverySet.has(code)) {
            result.rates_skipped++;
            continue;
          }

          const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}&token=${finnhubApiKey}`;
          const resp = await finnhubFetch.fetch(url);

          if (!resp.ok) {
            result.errors.push(`Finnhub HTTP ${resp.status} for ${code}`);
            continue;
          }

          const data = await resp.json();
          if (!data.c || data.c === 0) {
            result.errors.push(`Finnhub: no price for ${code}`);
            continue;
          }

          trackSuccess(code, "finnhub");

          const info = result.updatedRateSources[code];
          if (existing !== null && info?.preferred && info.preferred !== "finnhub") {
            continue;
          }

          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: "USD",
            rate: data.c.toString(),
            source: "finnhub",
          });
          result.rates_fetched++;
        }
      } catch (err) {
        result.errors.push(`Finnhub: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        finnhubFetch.dispose();
      }
    }
  }

  // Phase 3: Post-process — update rateSources based on successes
  for (const [code, sources] of successMap) {
    if (!result.updatedRateSources[code]) {
      result.updatedRateSources[code] = { available: [], preferred: "" };
    }
    const info = result.updatedRateSources[code];
    // Merge newly discovered sources into available list
    for (const src of sources) {
      if (!info.available.includes(src)) {
        info.available.push(src);
      }
    }

    if (!info.preferred) {
      if (info.available.length === 1) {
        // Auto-set preference for single-source currencies
        info.preferred = info.available[0];
      } else if (info.available.length > 1) {
        // Multiple sources available — needs user selection
        result.pendingChoices.push({
          currency: code,
          sources: [...info.available],
        });
      }
    }
  }

  // Mark newly used services as initialized
  if (frankfurterCodes.length > 0 && !initializedSet.has("frankfurter")) {
    result.updatedInitializedSources.push("frankfurter");
  }
  if (coingeckoCodes.length > 0 && coingeckoApiKey && !initializedSet.has("coingecko")) {
    result.updatedInitializedSources.push("coingecko");
  }
  if (finnhubCodes.length > 0 && finnhubApiKey && !initializedSet.has("finnhub")) {
    result.updatedInitializedSources.push("finnhub");
  }

  return result;
}

export async function fetchSingleRate(
  backend: Backend,
  code: string,
  source: SourceName,
  baseCurrency: string,
  coingeckoApiKey: string,
  finnhubApiKey: string,
): Promise<{ success: boolean; error?: string }> {
  const today = todayISO();

  switch (source) {
    case "frankfurter": {
      try {
        const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${code}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `Frankfurter HTTP ${resp.status}: ${resp.statusText}` };
        const data: FrankfurterResponse = await resp.json();
        const rateValue = data.rates[code];
        if (rateValue == null) return { success: false, error: `Frankfurter: no rate for ${code}` };
        const invertedRate = 1 / rateValue;
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: invertedRate.toString(),
          source: "frankfurter",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Frankfurter: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "coingecko": {
      if (!coingeckoApiKey) return { success: false, error: "CoinGecko API key is required" };
      try {
        const geckoId = COINGECKO_IDS[code] ?? code.toLowerCase();
        const vsBase = baseCurrency.toLowerCase();
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=${vsBase}&x_cg_demo_api_key=${coingeckoApiKey}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `CoinGecko HTTP ${resp.status}: ${resp.statusText}` };
        const data: CoinGeckoResponse = await resp.json();
        const priceData = data[geckoId];
        if (!priceData || priceData[vsBase] == null) return { success: false, error: `CoinGecko: no rate for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: priceData[vsBase].toString(),
          source: "coingecko",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `CoinGecko: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "finnhub": {
      if (!finnhubApiKey) return { success: false, error: "Finnhub API key is required" };
      try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}&token=${finnhubApiKey}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `Finnhub HTTP ${resp.status} for ${code}` };
        const data = await resp.json();
        if (!data.c || data.c === 0) return { success: false, error: `Finnhub: no price for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: "USD",
          rate: data.c.toString(),
          source: "finnhub",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Finnhub: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
}
