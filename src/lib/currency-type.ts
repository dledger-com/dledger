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

/** Common crypto ticker → CoinGecko ID mapping. */
export const KNOWN_CRYPTO = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "DOT",
  "AVAX", "MATIC", "POL", "LINK", "UNI", "ATOM", "LTC", "NEAR",
  "APT", "ARB", "OP", "FIL", "AAVE", "MKR", "SNX", "COMP",
  "CRV", "SHIB", "PEPE", "SUI", "SEI", "TIA",
  "USDT", "USDC", "DAI",
  // Native currencies from SUPPORTED_CHAINS
  "BNB", "POL", "AVAX", "MON", "S", "BTT", "HYPE", "GLMR",
  "MOVR", "MNT", "APE", "CELO", "BERA", "XDC", "STABLE",
  "MCORE", "PLASMA",
]);

/**
 * Infer the asset type for a currency code based on static heuristics.
 *
 * Returns `"fiat"` for known fiat codes, `"crypto"` for known crypto tickers,
 * or `""` (unclassified) for everything else.
 */
export function inferAssetType(code: string): CurrencyAssetType {
  if (FIAT_CURRENCIES.has(code)) return "fiat";
  if (KNOWN_CRYPTO.has(code)) return "crypto";
  return "";
}
