import type { CurrencyOrigin } from "./types/index.js";
import type { SourceName } from "./exchange-rate-sync.js";

// ECB/Frankfurter supported fiat currency codes
const FRANKFURTER_FIAT = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

export interface CurrencyContext {
  origins: Set<string>;           // "etherscan", "manual", "ledger-file", etc.
  recommendedSources: SourceName[];
  etherscanOnly: boolean;         // true if only seen in etherscan transactions
}

export type CurrencyContextMap = Map<string, CurrencyContext>;

/**
 * Build a context map from currency origin rows.
 *
 * Heuristic rules:
 * - Fiat (in FRANKFURTER_FIAT) → ["frankfurter"] (unchanged)
 * - etherscanOnly (non-fiat, only etherscan source) → ["coingecko"] only — never finnhub
 * - Mixed origins or manual/ledger-file only (non-fiat) → ["coingecko", "finnhub"] (unchanged)
 */
export function buildCurrencyContextMap(
  rows: CurrencyOrigin[],
  baseCurrency: string,
): CurrencyContextMap {
  // Group origins by currency
  const originsByCode = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.currency === baseCurrency) continue;
    let set = originsByCode.get(row.currency);
    if (!set) {
      set = new Set();
      originsByCode.set(row.currency, set);
    }
    set.add(row.origin);
  }

  const result: CurrencyContextMap = new Map();

  for (const [code, origins] of originsByCode) {
    const isFiat = FRANKFURTER_FIAT.has(code) && FRANKFURTER_FIAT.has(baseCurrency);
    const etherscanOnly = !isFiat && origins.size === 1 && origins.has("etherscan");

    let recommendedSources: SourceName[];
    if (isFiat) {
      recommendedSources = ["frankfurter"];
    } else if (etherscanOnly) {
      recommendedSources = ["coingecko"];
    } else {
      recommendedSources = ["coingecko", "finnhub"];
    }

    result.set(code, { origins, recommendedSources, etherscanOnly });
  }

  return result;
}
