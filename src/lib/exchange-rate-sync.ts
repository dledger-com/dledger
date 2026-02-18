import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend } from "./backend.js";

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

export async function syncExchangeRates(
  backend: Backend,
  baseCurrency: string,
  coingeckoApiKey: string,
  hiddenCurrencies: Set<string>,
): Promise<ExchangeRateSyncResult> {
  const result: ExchangeRateSyncResult = {
    rates_fetched: 0,
    rates_skipped: 0,
    errors: [],
  };

  const today = todayISO();
  const currencies = await backend.listCurrencies();
  const codes = currencies
    .map((c) => c.code)
    .filter((c) => c !== baseCurrency && !hiddenCurrencies.has(c));

  if (codes.length === 0) return result;

  const fiatCodes = codes.filter((c) => FRANKFURTER_FIAT.has(c));
  const cryptoCodes = codes.filter((c) => !FRANKFURTER_FIAT.has(c));

  // ---- Fiat rates via Frankfurter ----
  if (fiatCodes.length > 0 && FRANKFURTER_FIAT.has(baseCurrency)) {
    try {
      // Frankfurter returns "how many TARGET per 1 BASE"
      // We need "how many baseCurrency per 1 fiatCode" for each fiat code
      // So we request with each fiat code as base? No — more efficient to
      // request base=baseCurrency, get all rates, then invert.
      const symbols = fiatCodes.join(",");
      const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
      } else {
        const data: FrankfurterResponse = await resp.json();
        for (const code of fiatCodes) {
          const rateValue = data.rates[code];
          if (rateValue == null) {
            result.errors.push(`Frankfurter: no rate for ${code}`);
            continue;
          }

          // Check if rate already exists for today
          const existing = await backend.getExchangeRate(code, baseCurrency, today);
          if (existing !== null) {
            result.rates_skipped++;
            continue;
          }

          // Frankfurter gives: 1 baseCurrency = rateValue code
          // We need: 1 code = ? baseCurrency → invert
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
  } else if (fiatCodes.length > 0 && !FRANKFURTER_FIAT.has(baseCurrency)) {
    result.errors.push(
      `Frankfurter: base currency ${baseCurrency} is not a supported fiat currency; skipping ${fiatCodes.length} fiat rate(s)`,
    );
  }

  // ---- Crypto rates via CoinGecko ----
  if (cryptoCodes.length > 0) {
    if (!coingeckoApiKey) {
      result.errors.push(
        `CoinGecko: no API key provided; skipping ${cryptoCodes.length} crypto rate(s)`,
      );
    } else {
      const geckoFetch = new RateLimitedFetcher({ maxRequests: 30, intervalMs: 60_000 });
      try {
        // Map tickers to CoinGecko IDs
        const idMap = new Map<string, string>(); // geckoId → ticker
        const geckoIds: string[] = [];

        for (const code of cryptoCodes) {
          const geckoId = COINGECKO_IDS[code] ?? code.toLowerCase();
          idMap.set(geckoId, code);
          geckoIds.push(geckoId);
        }

        // CoinGecko supports comma-separated IDs in a single call
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

            // Check if rate already exists for today
            const existing = await backend.getExchangeRate(ticker, baseCurrency, today);
            if (existing !== null) {
              result.rates_skipped++;
              continue;
            }

            // CoinGecko gives: 1 ticker = priceData[vsBase] baseCurrency (direct)
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

  return result;
}
