import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateSource } from "./backend.js";
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

export type SourceName = "frankfurter" | "coingecko" | "finnhub" | "defillama" | "cryptocompare" | "binance" | "dprice";

/** Auto-detect the best source for a currency using static heuristics */
function autoDetectSource(
  code: string,
  assetType: string,
  baseCurrency: string,
  hasTokenAddress: boolean,
  dpriceAssets?: Set<string>,
): SourceName | "none" {
  // When dprice is enabled and the asset is available locally, prefer it
  if (dpriceAssets && dpriceAssets.has(code)) return "dprice";
  // Asset-type based routing (when classified)
  if (assetType === "fiat" && FRANKFURTER_FIAT.has(baseCurrency)) return "frankfurter";
  if (assetType === "crypto") return hasTokenAddress ? "defillama" : (COINGECKO_IDS[code] ? "defillama" : "none");
  if (assetType === "stock") return "none"; // finnhub requires API key; dprice handles stocks
  if (assetType === "commodity" || assetType === "index" || assetType === "bond") return "none";
  // Unclassified fallback: existing heuristics
  if (FRANKFURTER_FIAT.has(code) && FRANKFURTER_FIAT.has(baseCurrency)) return "frankfurter";
  if (hasTokenAddress) return "defillama";
  if (COINGECKO_IDS[code]) return "defillama";
  return "none";
}

/** Map base currency to Binance quote currency and construct trading pair */
function toBinancePair(currency: string, baseCurrency: string): string | null {
  const quoteMap: Record<string, string> = { USD: "USDT", EUR: "EUR" };
  const quote = quoteMap[baseCurrency] ?? baseCurrency;
  return `${currency}${quote}`;
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
  hiddenCurrencies: Set<string>,
  cryptoCompareApiKey?: string,
  dpriceMode?: DpriceMode,
  dpriceUrl?: string,
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
    .filter((c) => c !== baseCurrency && !hiddenCurrencies.has(c));

  if (codes.length === 0) return result;

  // Batch query: which currencies already have a rate recorded for today (exact date)?
  const filledToday = new Set(
    backend.getExchangeRateCurrenciesOnDate
      ? await backend.getExchangeRateCurrenciesOnDate(today)
      : [],
  );

  // Load stored rate source config
  const storedSources = await backend.getCurrencyRateSources();
  const sourceMap = new Map<string, CurrencyRateSource>();
  for (const src of storedSources) {
    sourceMap.set(src.currency, src);
  }

  // Load token addresses for auto-detection
  const tokenAddresses = await backend.getCurrencyTokenAddresses();
  const tokenAddrSet = new Set(tokenAddresses.map((t) => t.currency));

  // Build code → asset_type lookup for source detection
  const currencyTypeMap = new Map<string, string>();
  for (const c of currencies) {
    currencyTypeMap.set(c.code, c.asset_type);
  }

  // When dprice is enabled, try it FIRST for all currencies.
  // This dprice-first pass fetches actual rates and records them, avoiding redundant external API calls.
  let dpriceAssets: Set<string> | undefined;
  const dpriceServed = new Set<string>(); // codes successfully served by dprice this run
  if (isDpriceActive(dpriceMode)) {
    try {
      const client = createDpriceClient({ dpriceMode, dpriceUrl });
      // Request cross-rates for all codes (including baseCurrency for completeness)
      const entries = await client.getRates([...codes, baseCurrency]);
      dpriceAssets = new Set(entries.map((e) => e.from));

      // Filter entries that give us a direct rate to baseCurrency
      const baseRates = entries.filter((e) => e.to === baseCurrency);
      for (const entry of baseRates) {
        const code = entry.from;
        if (code === baseCurrency) continue;
        if (!codes.includes(code)) continue;

        // Respect user-priority source overrides: if user explicitly chose a different source, skip
        const stored = sourceMap.get(code);
        if (stored?.set_by === "user" && stored.rate_source !== null && stored.rate_source !== "dprice") {
          continue;
        }

        // Check if rate already exists today (exact date)
        if (filledToday.has(code)) {
          result.rates_skipped++;
          dpriceServed.add(code);
          continue;
        }

        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: entry.rate,
          source: "dprice",
        });
        result.rates_fetched++;
        dpriceServed.add(code);
        filledToday.add(code);
      }
    } catch {
      // dprice not available — fall through to other sources
    }
  }

  // Build per-source fetch lists
  const frankfurterCodes: string[] = [];
  const coingeckoCodes: string[] = [];
  const finnhubCodes: string[] = [];
  const defillamaCodes: string[] = [];
  const cryptocompareCodes: string[] = [];
  const binanceCodes: string[] = [];
  const dpriceCodes: string[] = [];
  const autoDetectCodes: string[] = []; // codes needing auto-detection

  for (const code of codes) {
    // Skip codes already served by the dprice-first pass
    if (dpriceServed.has(code)) continue;

    // Skip codes that already have a rate recorded today
    if (filledToday.has(code)) { result.rates_skipped++; continue; }

    const stored = sourceMap.get(code);
    if (stored && stored.rate_source !== null) {
      // Has configured source
      if (stored.rate_source === "none") continue; // skip entirely
      if (stored.rate_source === "frankfurter") frankfurterCodes.push(code);
      else if (stored.rate_source === "coingecko") coingeckoCodes.push(code);
      else if (stored.rate_source === "finnhub") finnhubCodes.push(code);
      else if (stored.rate_source === "defillama") defillamaCodes.push(code);
      else if (stored.rate_source === "cryptocompare") cryptocompareCodes.push(code);
      else if (stored.rate_source === "binance") binanceCodes.push(code);
      else if (stored.rate_source === "dprice") dpriceCodes.push(code);
    } else {
      // No stored source → auto-detect
      const detected = autoDetectSource(code, currencyTypeMap.get(code) ?? "", baseCurrency, tokenAddrSet.has(code), dpriceAssets);
      if (detected === "none") continue; // No known pricing path — skip
      if (detected === "frankfurter") frankfurterCodes.push(code);
      else if (detected === "coingecko") coingeckoCodes.push(code);
      else if (detected === "finnhub") finnhubCodes.push(code);
      else if (detected === "defillama") defillamaCodes.push(code);
      else if (detected === "cryptocompare") cryptocompareCodes.push(code);
      else if (detected === "binance") binanceCodes.push(code);
      else if (detected === "dprice") dpriceCodes.push(code);
      autoDetectCodes.push(code);
    }
  }

  // If dprice-first pass failed entirely (dpriceAssets still undefined), re-route dpriceCodes to fallback sources
  if (dpriceCodes.length > 0 && dpriceAssets === undefined) {
    for (const code of dpriceCodes) {
      const fallback = autoDetectSource(code, currencyTypeMap.get(code) ?? "", baseCurrency, tokenAddrSet.has(code), undefined);
      if (fallback === "none" || fallback === "dprice") continue;
      if (fallback === "frankfurter") frankfurterCodes.push(code);
      else if (fallback === "coingecko") coingeckoCodes.push(code);
      else if (fallback === "finnhub") finnhubCodes.push(code);
      else if (fallback === "defillama") defillamaCodes.push(code);
      else if (fallback === "cryptocompare") cryptocompareCodes.push(code);
      else if (fallback === "binance") binanceCodes.push(code);
    }
    dpriceCodes.length = 0; // Clear — they've been re-routed
  }

  // Track which auto-detect currencies succeeded
  const autoDetectSuccess = new Set<string>();
  const autoDetectFailed = new Set<string>();

  // Track ALL currencies (not just auto-detect) for auto-hide
  const allSucceeded = new Set<string>();
  const allFailed = new Set<string>();

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
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

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
        allFailed.add(code);
      }
    } else {
      const geckoFetch = new RateLimitedFetcher({ maxRequests: 30, intervalMs: 60_000 });
      try {
        const idMap = new Map<string, string>(); // geckoId → ticker
        const geckoIds: string[] = [];
        for (const code of coingeckoCodes) {
          const geckoId = COINGECKO_IDS[code] ?? code.toLowerCase();
          // Only send IDs that look valid for CoinGecko (lowercase alphanumeric + hyphens)
          if (!/^[a-z0-9][a-z0-9-]*$/.test(geckoId)) {
            result.errors.push(`CoinGecko: skipping invalid ID for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }
          idMap.set(geckoId, code);
          geckoIds.push(geckoId);
        }

        if (geckoIds.length > 0) {
          const ids = geckoIds.join(",");
          const vsBase = baseCurrency.toLowerCase();
          const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vsBase}&x_cg_demo_api_key=${coingeckoApiKey}`;
          const resp = await geckoFetch.fetch(url);

          if (!resp.ok) {
            result.errors.push(`CoinGecko HTTP ${resp.status}: ${resp.statusText}`);
            for (const [, ticker] of idMap) {
              if (autoDetectCodes.includes(ticker)) autoDetectFailed.add(ticker);
              allFailed.add(ticker);
            }
          } else {
            const data: CoinGeckoResponse = await resp.json();
            for (const [geckoId, ticker] of idMap) {
              const priceData = data[geckoId];
              if (!priceData || priceData[vsBase] == null) {
                result.errors.push(`CoinGecko: no rate for ${ticker} (id: ${geckoId})`);
                if (autoDetectCodes.includes(ticker)) autoDetectFailed.add(ticker);
                allFailed.add(ticker);
                continue;
              }

              if (autoDetectCodes.includes(ticker)) autoDetectSuccess.add(ticker);
              allSucceeded.add(ticker);

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
        allFailed.add(code);
      }
    } else {
      const finnhubFetch = new RateLimitedFetcher({ maxRequests: 55, intervalMs: 60_000 });
      try {
        for (const code of finnhubCodes) {
          const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}&token=${finnhubApiKey}`;
          const resp = await finnhubFetch.fetch(url);

          if (!resp.ok) {
            result.errors.push(`Finnhub HTTP ${resp.status} for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          const data = await resp.json();
          if (!data.c || data.c === 0) {
            result.errors.push(`Finnhub: no price for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

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

  // ---- CryptoCompare rates (current prices, batch) ----
  if (cryptocompareCodes.length > 0) {
    if (!cryptoCompareApiKey) {
      result.errors.push(
        `CryptoCompare: no API key provided; skipping ${cryptocompareCodes.length} rate(s)`,
      );
      for (const code of cryptocompareCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
        allFailed.add(code);
      }
    } else {
      try {
        const fsyms = cryptocompareCodes.join(",");
        const url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${fsyms}&tsyms=${baseCurrency}&api_key=${cryptoCompareApiKey}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          result.errors.push(`CryptoCompare HTTP ${resp.status}: ${resp.statusText}`);
          for (const code of cryptocompareCodes) {
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
          }
        } else {
          const data = await resp.json() as Record<string, Record<string, number>>;
          for (const code of cryptocompareCodes) {
            const priceData = data[code];
            if (!priceData || priceData[baseCurrency] == null) {
              result.errors.push(`CryptoCompare: no rate for ${code}`);
              if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
              allFailed.add(code);
              continue;
            }

            if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
            allSucceeded.add(code);

            await backend.recordExchangeRate({
              id: uuidv7(),
              date: today,
              from_currency: code,
              to_currency: baseCurrency,
              rate: priceData[baseCurrency].toString(),
              source: "cryptocompare",
            });
            result.rates_fetched++;
          }
        }
      } catch (err) {
        result.errors.push(`CryptoCompare: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---- DefiLlama rates (current prices, batch) ----
  if (defillamaCodes.length > 0) {
    try {
      // Build coin identifiers: token addresses or coingecko aliases
      const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));
      const coinIds: string[] = [];
      const coinToCode = new Map<string, string>();
      for (const code of defillamaCodes) {
        const ta = tokenAddrMap.get(code);
        let coinId: string;
        if (ta) {
          coinId = `${ta.chain}:${ta.contract_address}`;
        } else if (COINGECKO_IDS[code]) {
          coinId = `coingecko:${COINGECKO_IDS[code]}`;
        } else {
          // No token address and no CoinGecko mapping — skip to avoid garbage API calls
          continue;
        }
        coinIds.push(coinId);
        coinToCode.set(coinId, code);
      }

      // DefiLlama /prices/current supports comma-separated coins
      const url = `https://coins.llama.fi/prices/current/${coinIds.join(",")}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`DefiLlama HTTP ${resp.status}: ${resp.statusText}`);
        for (const code of defillamaCodes) {
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
        }
      } else {
        const data = await resp.json() as { coins: Record<string, { price: number; confidence?: number }> };
        for (const [coinId, code] of coinToCode) {
          const priceData = data.coins[coinId];
          if (!priceData || priceData.price == null) {
            result.errors.push(`DefiLlama: no price for ${code} (${coinId})`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

          // DefiLlama returns USD prices
          const toCurrency = "USD";
          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: toCurrency,
            rate: priceData.price.toString(),
            source: "defillama",
          });
          result.rates_fetched++;
        }
      }
    } catch (err) {
      result.errors.push(`DefiLlama: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Binance rates (current prices) ----
  if (binanceCodes.length > 0) {
    try {
      for (const code of binanceCodes) {
        const pair = toBinancePair(code, baseCurrency);
        if (!pair) {
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          result.errors.push(`Binance HTTP ${resp.status} for ${code} (${pair})`);
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        const data = await resp.json() as { price?: string };
        if (!data.price) {
          result.errors.push(`Binance: no price for ${code} (${pair})`);
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
        allSucceeded.add(code);

        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: data.price,
          source: "binance",
        });
        result.rates_fetched++;
      }
    } catch (err) {
      result.errors.push(`Binance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- dprice fallback: mark any unserved dpriceCodes as failed ----
  // These are codes routed to dprice (user-configured or auto-detected) that the dprice-first pass
  // couldn't serve — e.g. dprice was unavailable or didn't have a baseCurrency cross-rate.
  for (const code of dpriceCodes) {
    if (dpriceServed.has(code)) continue;
    if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
    allFailed.add(code);
  }

  // Post-process: Write auto-detection results to DB
  // Include dprice-served codes that had no prior stored source
  for (const code of dpriceServed) {
    const stored = sourceMap.get(code);
    if (!stored || stored.rate_source === null) {
      await backend.setCurrencyRateSource(code, "dprice", "auto");
      result.newlyDetected.push(code);
    }
    allSucceeded.add(code);
  }
  for (const code of autoDetectSuccess) {
    if (dpriceServed.has(code)) continue; // already handled above
    const detected = autoDetectSource(code, currencyTypeMap.get(code) ?? "", baseCurrency, tokenAddrSet.has(code), dpriceAssets);
    await backend.setCurrencyRateSource(code, detected, "auto");
    result.newlyDetected.push(code);
  }

  // Auto-hide: ALL currencies that failed, not just auto-detect ones.
  // setCurrencyRateSource priority system prevents overriding user/handler settings.
  for (const code of allFailed) {
    if (allSucceeded.has(code)) continue; // succeeded on another source
    const changed = await backend.setCurrencyRateSource(code, "none", "auto");
    if (changed) {
      result.autoHidden.push(code);
    }
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
  cryptoCompareApiKey?: string,
  dpriceMode?: DpriceMode,
  dpriceUrl?: string,
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

    case "defillama": {
      try {
        // Try to get token address, fall back to known coingecko alias
        const tokenAddr = await backend.getCurrencyTokenAddress(code);
        let coinId: string;
        if (tokenAddr) {
          coinId = `${tokenAddr.chain}:${tokenAddr.contract_address}`;
        } else if (COINGECKO_IDS[code]) {
          coinId = `coingecko:${COINGECKO_IDS[code]}`;
        } else {
          return { success: false, error: `DefiLlama: no token address or CoinGecko mapping for ${code}` };
        }
        const url = `https://coins.llama.fi/prices/current/${coinId}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `DefiLlama HTTP ${resp.status}: ${resp.statusText}` };
        const data = await resp.json() as { coins: Record<string, { price: number }> };
        const priceData = data.coins[coinId];
        if (!priceData || priceData.price == null) return { success: false, error: `DefiLlama: no price for ${code} (${coinId})` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: "USD",
          rate: priceData.price.toString(),
          source: "defillama",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `DefiLlama: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "cryptocompare": {
      if (!cryptoCompareApiKey) return { success: false, error: "CryptoCompare API key is required" };
      try {
        const url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${code}&tsyms=${baseCurrency}&api_key=${cryptoCompareApiKey}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `CryptoCompare HTTP ${resp.status}: ${resp.statusText}` };
        const data = await resp.json() as Record<string, Record<string, number>>;
        const priceData = data[code];
        if (!priceData || priceData[baseCurrency] == null) return { success: false, error: `CryptoCompare: no rate for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: priceData[baseCurrency].toString(),
          source: "cryptocompare",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `CryptoCompare: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "binance": {
      try {
        const pair = toBinancePair(code, baseCurrency);
        if (!pair) return { success: false, error: `Binance: cannot form pair for ${code}/${baseCurrency}` };
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `Binance HTTP ${resp.status} for ${code} (${pair})` };
        const data = await resp.json() as { price?: string };
        if (!data.price) return { success: false, error: `Binance: no price for ${code} (${pair})` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: data.price,
          source: "binance",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Binance: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "dprice": {
      try {
        const client = createDpriceClient({ dpriceMode, dpriceUrl });
        const rate = await client.getRate(code, baseCurrency);
        if (rate == null) return { success: false, error: `dprice: no rate for ${code}/${baseCurrency}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate,
          source: "dprice",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `dprice: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
}
