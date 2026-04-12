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
 * Priority: 1) crypto_asset_info DB  2) hardcoded map  3) code.toLowerCase()
 */
export function resolveGeckoId(
  code: string,
  dynamicMap?: Map<string, string>,
): string {
  const dbId = dynamicMap?.get(code);
  if (dbId) return dbId;
  if (COINGECKO_IDS[code]) return COINGECKO_IDS[code];
  return code.toLowerCase();
}

/** Validate a CoinGecko ID format (lowercase alphanumeric + hyphens) */
export function isValidGeckoId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** Check if a currency has a known CoinGecko ID (hardcoded or dynamic) */
export function hasGeckoId(code: string, dynamicMap?: Map<string, string>): boolean {
  return !!(dynamicMap?.get(code) || COINGECKO_IDS[code]);
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
