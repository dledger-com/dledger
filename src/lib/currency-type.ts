/**
 * Currency asset-type inference utility.
 *
 * Maps well-known currency codes to their asset type based on static heuristic
 * sets. Used when creating currencies to populate the `asset_type` field.
 */

import type { CurrencyAssetType } from "./types/account.js";

/** ECB/Frankfurter supported fiat currency codes. */
export const FIAT_CURRENCIES = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

/**
 * Infer the asset type for a currency code based on static heuristics.
 *
 * Returns `"fiat"` for known fiat codes, or `""` (unclassified) for everything
 * else. Crypto/stock/commodity types are populated dynamically by the rate sync
 * system after querying dprice or other currency sources.
 */
export function inferAssetType(code: string): CurrencyAssetType {
  if (FIAT_CURRENCIES.has(code)) return "fiat";
  return "";
}
