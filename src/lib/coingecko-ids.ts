// Common crypto ticker → CoinGecko ID mapping (hardcoded fallback)
export const COINGECKO_IDS: Record<string, string> = {
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

/**
 * Resolve a currency code to a CoinGecko ID.
 * Priority: 1) crypto_asset_info DB  2) hardcoded map  3) coins/list cache  4) code.toLowerCase()
 */
export function resolveGeckoId(
  code: string,
  dynamicMap?: Map<string, string>,
): string {
  const dbId = dynamicMap?.get(code);
  if (dbId) return dbId;
  if (COINGECKO_IDS[code]) return COINGECKO_IDS[code];
  const cached = _coinListCache?.get(code);
  if (cached) return cached;
  return code.toLowerCase();
}

/** Validate a CoinGecko ID format (lowercase alphanumeric + hyphens) */
export function isValidGeckoId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** Check if a currency has a known CoinGecko ID (hardcoded, dynamic, or cached) */
export function hasGeckoId(code: string, dynamicMap?: Map<string, string>): boolean {
  return !!(dynamicMap?.get(code) || COINGECKO_IDS[code] || _coinListCache?.get(code));
}

// ---- Dynamic coin list refresh ----

/** In-memory cache of the full CoinGecko coin list (symbol → gecko ID) */
let _coinListCache: Map<string, string> | null = null;
let _coinListTime = 0;
const COIN_LIST_TTL = 24 * 60 * 60 * 1000; // 24h

/**
 * Fetch the full CoinGecko coin list and persist IDs for the user's currencies.
 * The full list (~15k coins) is cached in memory for the session; only currencies
 * the user actually has are persisted to the crypto_asset_info table.
 *
 * @param userCurrencies - set of currency codes the user has in their ledger
 * @param persistFn - function to persist a (code, geckoId) pair to the DB
 */
export async function refreshCoinGeckoIds(
  userCurrencies: Set<string>,
  persistFn: (code: string, geckoId: string) => Promise<void>,
  apiKey?: string,
  pro?: boolean,
): Promise<Map<string, string>> {
  // Return cached list if still fresh
  if (_coinListCache && Date.now() - _coinListTime < COIN_LIST_TTL) {
    return _coinListCache;
  }

  const base = pro ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  const headers: Record<string, string> = apiKey
    ? (pro ? { "x-cg-pro-api-key": apiKey } : { "x-cg-demo-api-key": apiKey })
    : {};
  const resp = await fetch(`${base}/coins/list`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`CoinGecko coins/list HTTP ${resp.status}`);
  const coins: Array<{ id: string; symbol: string; name: string }> = await resp.json();

  // Build symbol → id map. For duplicate symbols, prefer the one matching our
  // hardcoded map (known good IDs), otherwise keep the first occurrence
  // (coins/list is alphabetical, but popular coins tend to have shorter IDs).
  const symbolToId = new Map<string, string>();
  for (const coin of coins) {
    const sym = coin.symbol.toUpperCase();
    if (!symbolToId.has(sym) || COINGECKO_IDS[sym] === coin.id) {
      symbolToId.set(sym, coin.id);
    }
  }

  _coinListCache = symbolToId;
  _coinListTime = Date.now();

  // Persist only the user's currencies to the DB (avoid writing 15k+ rows)
  for (const code of userCurrencies) {
    const geckoId = symbolToId.get(code);
    if (geckoId) {
      try { await persistFn(code, geckoId); } catch { /* non-critical */ }
    }
  }

  return symbolToId;
}

/** Clear the in-memory coin list cache (for testing) */
export function clearCoinListCache(): void {
  _coinListCache = null;
  _coinListTime = 0;
}

// CoinGecko asset platform IDs for token_price endpoint
export const CHAIN_TO_PLATFORM: Record<string, string> = {
  ethereum: "ethereum",
  polygon: "polygon-pos",
  bsc: "binance-smart-chain",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  base: "base",
  avalanche: "avalanche",
  fantom: "fantom",
  gnosis: "xdai",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  mantle: "mantle",
  moonbeam: "moonbeam",
  celo: "celo",
};
