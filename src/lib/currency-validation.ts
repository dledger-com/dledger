/**
 * Currency code validation — filters spam/garbage codes from DeFi imports.
 *
 * Valid codes: uppercase letters, digits, dots, hyphens, underscores, slashes.
 * Examples: "USD", "BTC", "WBTC", "USD.E", "LP-USDC/ETH"
 * Invalid: "", "💰TOKEN", "0x1234...", Unicode, whitespace-only
 */

const VALID_CODE_RE = /^[A-Z0-9._\-/]+$/;

/**
 * Check whether a currency code is valid (non-spam).
 * Uppercases before testing so "btc" passes.
 */
export function isValidCurrencyCode(code: string): boolean {
  if (!code || !code.trim()) return false;
  return VALID_CODE_RE.test(code.toUpperCase());
}

/**
 * Inverse of isValidCurrencyCode — true for garbage/spam codes.
 */
export function isSpamCurrency(code: string): boolean {
  return !isValidCurrencyCode(code);
}
