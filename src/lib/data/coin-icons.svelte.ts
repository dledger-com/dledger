/**
 * Reactive store for cryptocurrency icon URLs.
 * Fetches from CoinGecko /coins/markets API, caches image data as data URIs
 * in both localStorage (sync, for instant first render) and IndexedDB (persistent, larger capacity).
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

// ---- localStorage (sync, fast first render) ----

const STORAGE_KEY = "coin-icon-cache";
const CACHE_VERSION = 2; // bump: now stores data URIs instead of URLs

function loadFromStorage(): Map<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (parsed.v !== CACHE_VERSION) return new Map(); // discard old URL-based cache
    return new Map(Object.entries(parsed.data));
  } catch {
    return new Map();
  }
}

function saveToStorage(icons: Map<string, string>): void {
  try {
    const data = Object.fromEntries(icons);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: CACHE_VERSION, data }));
  } catch { /* quota exceeded — IndexedDB still has the data */ }
}

// ---- IndexedDB (persistent, larger capacity) ----

const DB_NAME = "dledger-icon-cache";
const STORE_NAME = "icons";
const DB_VERSION = 1;

function openIconDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadIconsFromIDB(): Promise<Map<string, string>> {
  try {
    const db = await openIconDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      const keyReq = store.getAllKeys();
      tx.oncomplete = () => {
        const map = new Map<string, string>();
        for (let i = 0; i < keyReq.result.length; i++) {
          map.set(keyReq.result[i] as string, req.result[i]);
        }
        resolve(map);
      };
      tx.onerror = () => resolve(new Map());
    });
  } catch { return new Map(); }
}

async function saveIconsToIDB(newIcons: Map<string, string>): Promise<void> {
  try {
    const db = await openIconDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of newIcons) {
      store.put(value, key);
    }
  } catch { /* ignore */ }
}

// ---- Image fetching ----

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    // TODO: CoinGecko CDN and Google Favicons block cross-origin fetch (CORS).
    // Proxy through backend to enable local caching.
    if (url.includes("coingecko.com") || url.includes("google.com/s2/favicons")) return null;

    // Use "small" size (~64px) for compact icons
    const smallUrl = url.replace("/large/", "/small/");
    const resp = await fetch(smallUrl);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

// ---- Module-level state ----

// Load from localStorage synchronously for instant first render (no flash of fallback circles)
let _icons: Map<string, string> = loadFromStorage();
let _initialized = false;
let _listeners: Set<() => void> = new Set();

function notify(): void {
  for (const fn of _listeners) fn();
}

/**
 * Get icon URL for a currency symbol. Returns data URI from cache, or null if not cached.
 * For fiat currencies, returns cached flag data URI if available, otherwise the external URL as fallback.
 */
export function getCoinIconUrl(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  const cached = _icons.get(upper);
  if (cached) return cached;
  // Fiat fallback: return external URL (will be cached as data URI on next init)
  const flag = FIAT_FLAGS[upper];
  if (flag) return `https://hatscripts.github.io/circle-flags/flags/${flag}.svg`;
  return null;
}

/**
 * Subscribe to icon cache changes (for reactivity).
 */
export function onCoinIconsChanged(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Check if a cached value is a local data URI (not an external URL that needs re-fetching) */
function isLocalCache(value: string): boolean {
  return value.startsWith("data:");
}

/**
 * Initialize coin icons: load from IndexedDB, then fetch missing icons from CoinGecko as data URIs.
 * Call once on app startup with the list of currency codes the user has.
 */
export async function initCoinIcons(currencyCodes: string[]): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Merge IndexedDB cache (may have more entries than localStorage due to quota)
  const idbIcons = await loadIconsFromIDB();
  if (idbIcons.size > 0) {
    let merged = false;
    for (const [k, v] of idbIcons) {
      if (!_icons.has(k) || !isLocalCache(_icons.get(k)!)) {
        _icons.set(k, v);
        merged = true;
      }
    }
    if (merged) notify();
  }

  // Cache fiat flag SVGs as data URIs
  const fiatMissing: string[] = [];
  for (const code of currencyCodes) {
    const upper = code.toUpperCase();
    if (FIAT_FLAGS[upper] && (!_icons.has(upper) || !isLocalCache(_icons.get(upper)!))) {
      fiatMissing.push(upper);
    }
  }
  if (fiatMissing.length > 0) {
    const fiatNew = new Map<string, string>();
    for (const upper of fiatMissing) {
      const flag = FIAT_FLAGS[upper];
      const url = `https://hatscripts.github.io/circle-flags/flags/${flag}.svg`;
      const dataUri = await fetchAsDataUri(url);
      if (dataUri) {
        _icons.set(upper, dataUri);
        fiatNew.set(upper, dataUri);
      }
    }
    if (fiatNew.size > 0) {
      saveToStorage(_icons);
      await saveIconsToIDB(fiatNew);
      notify();
    }
  }

  // Find crypto symbols that need fetching — split into known IDs and unknown (try by lowercase symbol)
  const knownMissing: string[] = [];
  const unknownMissing: string[] = [];
  for (const code of currencyCodes) {
    const upper = code.toUpperCase();
    const cached = _icons.get(upper);
    if (cached && isLocalCache(cached)) continue; // already have data URI
    if (COINGECKO_IDS[upper] === "" || FIAT_FLAGS[upper]) continue; // fiat — handled above
    if (COINGECKO_IDS[upper]) {
      knownMissing.push(upper);
    } else {
      unknownMissing.push(upper);
    }
  }

  if (knownMissing.length === 0 && unknownMissing.length === 0) return;

  const newIcons = new Map<string, string>();

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
            const dataUri = await fetchAsDataUri(coin.image);
            if (dataUri) {
              _icons.set(upper, dataUri);
              newIcons.set(upper, dataUri);
            }
          }
        }
      }
    }

    // Batch 2: try unknown currencies by lowercase symbol as CoinGecko ID
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
            const dataUri = await fetchAsDataUri(coin.image);
            if (dataUri) {
              _icons.set(upper, dataUri);
              newIcons.set(upper, dataUri);
            }
          }
        }
      }
    }

    if (newIcons.size > 0) {
      saveToStorage(_icons);
      await saveIconsToIDB(newIcons);
      notify();
    }
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

// ---- General-purpose icon cache for any external URL ----

// In-flight fetches to avoid duplicate requests for the same key
const _inflight = new Map<string, Promise<string | null>>();
// Keys that failed to fetch (404, CORS, etc.) — don't retry within this session
const _failedKeys = new Set<string>();

/**
 * Get a cached icon by arbitrary key (e.g., "chain:bitcoin", "exchange:kraken").
 * Returns data URI if cached, null otherwise.
 */
export function getCachedIcon(key: string): string | null {
  return _icons.get(key) ?? null;
}

/**
 * Ensure an external icon URL is cached locally as a data URI.
 * Returns the data URI immediately if cached, otherwise fetches in the background
 * and calls notify() when ready (triggering reactive updates via onCoinIconsChanged).
 *
 * @param key - Cache key (e.g., "chain:hl", "exchange:kraken")
 * @param url - External URL to fetch if not cached
 * @returns Data URI if already cached, or the external URL as fallback while fetching
 */
export function cacheExternalIcon(key: string, url: string): string {
  const cached = _icons.get(key);
  if (cached && isLocalCache(cached)) return cached;

  // Already fetching or previously failed — use external URL as-is
  if (_inflight.has(key) || _failedKeys.has(key)) return cached ?? url;

  // Fetch in background
  const promise = fetchAsDataUri(url).then(async (dataUri) => {
    _inflight.delete(key);
    if (dataUri) {
      _icons.set(key, dataUri);
      saveToStorage(_icons);
      await saveIconsToIDB(new Map([[key, dataUri]]));
      notify();
    } else {
      _failedKeys.add(key); // don't retry failed fetches this session
    }
    return dataUri;
  });
  _inflight.set(key, promise);

  return cached ?? url; // return external URL as fallback while fetching
}
