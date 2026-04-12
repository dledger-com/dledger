/** Cached set of supported CoinGecko vs_currencies. Refreshed at most once per 24h. */
let cached: Set<string> | null = null;
let cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Hardcoded fallback (subset of commonly supported vs_currencies)
const FALLBACK_VS_CURRENCIES = new Set([
  "usd", "eur", "gbp", "jpy", "btc", "eth", "cny", "krw",
  "aud", "cad", "chf", "hkd", "inr", "sgd", "brl", "mxn",
  "nzd", "sek", "nok", "dkk", "pln", "czk", "huf", "try",
  "zar", "ils", "thb", "php", "idr", "myr", "rub",
]);

export async function getSupportedVsCurrencies(
  apiKey?: string,
  pro?: boolean,
): Promise<Set<string>> {
  if (cached && Date.now() - cacheTime < CACHE_TTL) return cached;
  try {
    const base = pro ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
    const headers: Record<string, string> = apiKey
      ? (pro ? { "x-cg-pro-api-key": apiKey } : { "x-cg-demo-api-key": apiKey })
      : {};
    const resp = await fetch(`${base}/simple/supported_vs_currencies`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const list: string[] = await resp.json();
      cached = new Set(list);
      cacheTime = Date.now();
      return cached;
    }
  } catch { /* fall through to hardcoded fallback */ }
  return FALLBACK_VS_CURRENCIES;
}

export function isVsCurrencySupported(code: string, supported: Set<string>): boolean {
  return supported.has(code.toLowerCase());
}
