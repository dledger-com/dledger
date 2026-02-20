import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateSource } from "./backend.js";

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
  autoHidden: string[];
  newlyDetected: string[]; // currencies auto-detected this run
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

/** Auto-detect the best source for a currency using static heuristics */
function autoDetectSource(code: string, baseCurrency: string): SourceName {
  if (FRANKFURTER_FIAT.has(code) && FRANKFURTER_FIAT.has(baseCurrency)) {
    return "frankfurter";
  }
  return "coingecko";
}

/**
 * Simplified exchange rate sync. Uses DB-stored currency_rate_source as single source of truth.
 *
 * For each non-base, non-hidden currency:
 * - Has stored rate_source → use that (skip "none")
 * - No stored source → auto-detect: fiat → frankfurter, else → coingecko
 * - Write auto-detection results to DB inline
 * - Etherscan-only currencies where all sources fail → auto-hide
 */
export async function syncExchangeRates(
  backend: Backend,
  baseCurrency: string,
  coingeckoApiKey: string,
  finnhubApiKey: string,
  spamCurrencies: Set<string>,
): Promise<ExchangeRateSyncResult> {
  const result: ExchangeRateSyncResult = {
    rates_fetched: 0,
    rates_skipped: 0,
    errors: [],
    autoHidden: [],
    newlyDetected: [],
  };

  const today = todayISO();
  const currencies = await backend.listCurrencies();
  const codes = currencies
    .map((c) => c.code)
    .filter((c) => c !== baseCurrency && !spamCurrencies.has(c));

  if (codes.length === 0) return result;

  // Load stored rate source config
  const storedSources = await backend.getCurrencyRateSources();
  const sourceMap = new Map<string, CurrencyRateSource>();
  for (const src of storedSources) {
    sourceMap.set(src.currency, src);
  }

  // Build per-source fetch lists
  const frankfurterCodes: string[] = [];
  const coingeckoCodes: string[] = [];
  const finnhubCodes: string[] = [];
  const autoDetectCodes: string[] = []; // codes needing auto-detection

  for (const code of codes) {
    const stored = sourceMap.get(code);
    if (stored && stored.rate_source !== null) {
      // Has configured source
      if (stored.rate_source === "none") continue; // skip entirely
      if (stored.rate_source === "frankfurter") frankfurterCodes.push(code);
      else if (stored.rate_source === "coingecko") coingeckoCodes.push(code);
      else if (stored.rate_source === "finnhub") finnhubCodes.push(code);
    } else {
      // No stored source → auto-detect
      const detected = autoDetectSource(code, baseCurrency);
      if (detected === "frankfurter") frankfurterCodes.push(code);
      else if (detected === "coingecko") coingeckoCodes.push(code);
      else if (detected === "finnhub") finnhubCodes.push(code);
      autoDetectCodes.push(code);
    }
  }

  // Track which auto-detect currencies succeeded
  const autoDetectSuccess = new Set<string>();
  const autoDetectFailed = new Set<string>();

  // ---- Fiat rates via Frankfurter ----
  if (frankfurterCodes.length > 0) {
    try {
      const symbols = frankfurterCodes.join(",");
      const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
      } else {
        const data: FrankfurterResponse = await resp.json();
        for (const code of frankfurterCodes) {
          const rateValue = data.rates[code];
          if (rateValue == null) {
            result.errors.push(`Frankfurter: no rate for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);

          const existing = await backend.getExchangeRate(code, baseCurrency, today);
          if (existing !== null) {
            result.rates_skipped++;
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
      // Mark all as failed for auto-detect
      for (const code of coingeckoCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
      }
    } else {
      const geckoFetch = new RateLimitedFetcher({ maxRequests: 30, intervalMs: 60_000 });
      try {
        const idMap = new Map<string, string>(); // geckoId → ticker
        const geckoIds: string[] = [];
        for (const code of coingeckoCodes) {
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
          for (const code of coingeckoCodes) {
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          }
        } else {
          const data: CoinGeckoResponse = await resp.json();
          for (const [geckoId, ticker] of idMap) {
            const priceData = data[geckoId];
            if (!priceData || priceData[vsBase] == null) {
              result.errors.push(`CoinGecko: no rate for ${ticker} (id: ${geckoId})`);
              if (autoDetectCodes.includes(ticker)) autoDetectFailed.add(ticker);
              continue;
            }

            if (autoDetectCodes.includes(ticker)) autoDetectSuccess.add(ticker);

            const existing = await backend.getExchangeRate(ticker, baseCurrency, today);
            if (existing !== null) {
              result.rates_skipped++;
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
      for (const code of finnhubCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
      }
    } else {
      const finnhubFetch = new RateLimitedFetcher({ maxRequests: 55, intervalMs: 60_000 });
      try {
        for (const code of finnhubCodes) {
          const existing = await backend.getExchangeRate(code, "USD", today);
          if (existing !== null) {
            result.rates_skipped++;
            if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
            continue;
          }

          const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}&token=${finnhubApiKey}`;
          const resp = await finnhubFetch.fetch(url);

          if (!resp.ok) {
            result.errors.push(`Finnhub HTTP ${resp.status} for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            continue;
          }

          const data = await resp.json();
          if (!data.c || data.c === 0) {
            result.errors.push(`Finnhub: no price for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);

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

  // Post-process: Write auto-detection results to DB
  for (const code of autoDetectSuccess) {
    const detected = autoDetectSource(code, baseCurrency);
    await backend.setCurrencyRateSource(code, detected, "auto");
    result.newlyDetected.push(code);
  }

  // Auto-hide: currencies that failed all sources and have no stored config
  // (likely spam tokens from etherscan)
  for (const code of autoDetectFailed) {
    if (autoDetectSuccess.has(code)) continue; // succeeded on fallback
    await backend.setCurrencyRateSource(code, "none", "auto");
    result.autoHidden.push(code);
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
