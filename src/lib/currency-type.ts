/**
 * Currency asset-type inference utility.
 *
 * Maps well-known currency codes to their asset type based on static heuristic
 * sets. Used when creating currencies to populate the `asset_type` field.
 */

import type { CurrencyAssetType } from "./types/account.js";
import type { Backend } from "./backend.js";

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

/**
 * Context hint for ensureCurrency — determines the default asset_type based on
 * the import source when the currency code is not in the static fiat set.
 */
export type CurrencySourceContext = "bank" | "crypto-chain" | "exchange" | "ledger" | "manual";

/**
 * Determine asset_type based on source context and code.
 * - bank → always "fiat"
 * - crypto-chain → always "crypto" (unless code is known fiat like USD on Solana)
 * - exchange → "fiat" if known fiat, else "crypto"
 * - ledger/manual → inferAssetType (fiat if known, else "")
 */
export function resolveAssetType(code: string, context?: CurrencySourceContext): CurrencyAssetType {
  if (context === "bank") return "fiat";
  if (context === "crypto-chain") return FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
  if (context === "exchange") return FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
  return inferAssetType(code);
}

/**
 * Shared ensureCurrency function — creates a currency if it doesn't exist in the cache.
 * Determines asset_type from source context.
 */
export async function ensureCurrencyExists(
  backend: Backend,
  code: string,
  cache: Set<string>,
  opts?: {
    context?: CurrencySourceContext;
    type?: CurrencyAssetType;
    decimals?: number;
    contractAddress?: string;
    chain?: string;
  },
): Promise<void> {
  if (cache.has(code)) return;
  const assetType = opts?.type ?? resolveAssetType(code, opts?.context);
  const decimals = opts?.decimals ?? (code.length <= 3 ? 2 : 8);
  await backend.createCurrency({
    code,
    asset_type: assetType,
    name: code,
    decimal_places: decimals,
  });
  cache.add(code);
  if (opts?.contractAddress && opts?.chain) {
    try {
      await backend.setCurrencyTokenAddress(code, opts.chain, opts.contractAddress.toLowerCase());
    } catch {
      // May already exist (INSERT OR IGNORE)
    }
  }
}
