/**
 * Reactive store for cryptocurrency icon URLs.
 * Fetches from CoinGecko /coins/markets API, caches in localStorage.
 */

// Well-known CoinGecko IDs for common currencies (uppercase symbol → coingecko id)
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", DOT: "polkadot",
  AVAX: "avalanche-2", MATIC: "matic-network", POL: "matic-network",
  LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos", LTC: "litecoin",
  NEAR: "near", APT: "aptos", ARB: "arbitrum", OP: "optimism",
  FIL: "filecoin", AAVE: "aave", MKR: "maker", SNX: "havven",
  COMP: "compound-governance-token", CRV: "curve-dao-token",
  SHIB: "shiba-inu", PEPE: "pepe", SUI: "sui", SEI: "sei-network",
  TIA: "celestia", USDT: "tether", USDC: "usd-coin", DAI: "dai",
  ALGO: "algorand", XMR: "monero", ZEC: "zcash", XLM: "stellar",
  HBAR: "hedera-hashgraph", TAO: "bittensor", XTZ: "tezos",
  KAS: "kaspa", STX: "blockstack", TRX: "tron", TON: "the-open-network",
  WETH: "weth", WBTC: "wrapped-bitcoin", STETH: "staked-ether",
  GRT: "the-graph", ENS: "ethereum-name-service", LDO: "lido-dao",
  PENDLE: "pendle", BAL: "balancer", YFI: "yearn-finance",
  EIGEN: "eigenlayer", LIDO: "lido-dao", RPL: "rocket-pool",
  FTM: "fantom", CELO: "celo", GLMR: "moonbeam", MOVR: "moonriver",
  MNT: "mantle", APE: "apecoin", CHZ: "chiliz", VET: "vechain",
  BERA: "berachain", HYPE: "hyperliquid",
  JUP: "jupiter-exchange-solana", JTO: "jito-governance-token",
  RAY: "raydium", MNDE: "marinade",
  ETC: "ethereum-classic", FLR: "flare-networks", BCH: "bitcoin-cash",
  CRO: "crypto-com-chain", S: "sonic-3", BTT: "bittorrent",
  // DeFi protocol tokens
  SUSHI: "sushi", CAKE: "pancakeswap-token", QUICK: "quickswap",
  GRAIL: "camelot-token", PSP: "paraswap", HOP: "hop-protocol",
  MORPHO: "morpho", LQTY: "liquity", XVS: "venus",
  CVX: "convex-finance", AURA: "aura-finance",
  AERO: "aerodrome-finance", VELO: "velodrome-finance",
  ETHFI: "ether-fi", REZ: "renzo", SWELL: "swell-network",
  SWISE: "stakewise", FXS: "frax-share", ENA: "ethena",
  BIFI: "beefy-finance", FARM: "harvest-finance",
  SOMM: "sommelier", BADGER: "badger-dao", ANGLE: "angle-protocol",
  EUL: "euler", RDNT: "radiant-capital",
  GMX: "gmx", OGN: "origin-protocol", NOTE: "notional-finance",
  DYDX: "dydx-chain",
  // Fiat (empty string = skip CoinGecko fetch, flags handled by FIAT_FLAGS below)
  USD: "", EUR: "", GBP: "", JPY: "", CHF: "", CAD: "", AUD: "", CNY: "",
};

/** Fiat currency code → ISO 3166-1 alpha-2 country code for circle flag icons */
const FIAT_FLAGS: Record<string, string> = {
  USD: "us", EUR: "european_union", GBP: "gb", JPY: "jp",
  CHF: "ch", CAD: "ca", AUD: "au", CNY: "cn",
  NZD: "nz", SEK: "se", NOK: "no", DKK: "dk",
  SGD: "sg", HKD: "hk", KRW: "kr", INR: "in",
  BRL: "br", MXN: "mx", ZAR: "za", PLN: "pl",
  CZK: "cz", HUF: "hu", TRY: "tr", THB: "th",
  RUB: "ru", ILS: "il", AED: "ae", SAR: "sa",
};

const STORAGE_KEY = "coin-icon-cache";
const CACHE_VERSION = 1;

// Module-level state
let _icons: Map<string, string> = new Map();
let _initialized = false;
let _listeners: Set<() => void> = new Set();

function loadFromStorage(): Map<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (parsed.v !== CACHE_VERSION) return new Map();
    return new Map(Object.entries(parsed.data));
  } catch {
    return new Map();
  }
}

function saveToStorage(icons: Map<string, string>): void {
  try {
    const data = Object.fromEntries(icons);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: CACHE_VERSION, data }));
  } catch { /* quota exceeded — ignore */ }
}

function notify(): void {
  for (const fn of _listeners) fn();
}

/**
 * Get icon URL for a currency symbol. Returns null if not cached.
 */
export function getCoinIconUrl(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  const flag = FIAT_FLAGS[upper];
  if (flag) return `https://hatscripts.github.io/circle-flags/flags/${flag}.svg`;
  return _icons.get(upper) ?? null;
}

/**
 * Subscribe to icon cache changes (for reactivity).
 */
export function onCoinIconsChanged(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Initialize coin icons: load cache, then fetch missing icons from CoinGecko.
 * Call once on app startup with the list of currency codes the user has.
 */
export async function initCoinIcons(currencyCodes: string[]): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Load cache
  _icons = loadFromStorage();
  notify();

  // Find symbols that need fetching — split into known IDs and unknown (try by lowercase symbol)
  const knownMissing: string[] = [];
  const unknownMissing: string[] = [];
  for (const code of currencyCodes) {
    const upper = code.toUpperCase();
    if (_icons.has(upper)) continue;
    if (COINGECKO_IDS[upper] === "") continue; // fiat — no icon
    if (COINGECKO_IDS[upper]) {
      knownMissing.push(upper);
    } else {
      unknownMissing.push(upper);
    }
  }

  if (knownMissing.length === 0 && unknownMissing.length === 0) return;

  try {
    // Batch 1: fetch well-known currencies by their CoinGecko ID
    if (knownMissing.length > 0) {
      const geckoIds = knownMissing
        .map(s => COINGECKO_IDS[s])
        .filter(Boolean);
      const unique = [...new Set(geckoIds)];

      for (let i = 0; i < unique.length; i += 250) {
        const batch = unique.slice(i, i + 250);
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${batch.join(",")}&per_page=250&sparkline=false`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json() as Array<{ id: string; symbol: string; image: string }>;

        for (const coin of data) {
          const upper = coin.symbol.toUpperCase();
          if (coin.image && !coin.image.includes("missing")) {
            _icons.set(upper, coin.image);
          }
        }
      }
    }

    // Batch 2: try unknown currencies by lowercase symbol as CoinGecko ID (works for many tokens)
    if (unknownMissing.length > 0) {
      const guessIds = unknownMissing.map(s => s.toLowerCase());

      for (let i = 0; i < guessIds.length; i += 250) {
        const batch = guessIds.slice(i, i + 250);
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${batch.join(",")}&per_page=250&sparkline=false`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json() as Array<{ id: string; symbol: string; image: string }>;

        for (const coin of data) {
          const upper = coin.symbol.toUpperCase();
          if (coin.image && !coin.image.includes("missing")) {
            _icons.set(upper, coin.image);
          }
        }
      }
    }

    saveToStorage(_icons);
    notify();
  } catch {
    // Network error — use whatever we have cached
  }
}

/**
 * Get the current icon count (for debugging).
 */
export function getCoinIconCount(): number {
  return _icons.size;
}
