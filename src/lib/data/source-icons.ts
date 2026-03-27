/**
 * Parse journal entry source strings and resolve to icon URLs.
 * Priority: protocol CoinIcon > L2 chain icon > L1 native CoinIcon > exchange icon > fallback.
 */
import { INSTITUTION_REGISTRY, type InstitutionInfo } from "$lib/cex/institution-registry.js";
import { getExchangeIconUrl } from "$lib/data/exchange-icons.js";
import { CHAIN_ICONS, NAMED_CHAIN_ICONS } from "$lib/data/chain-icons.js";
import { SUPPORTED_CHAINS } from "$lib/types/index.js";
import { BLOCKCHAIN_CHAINS } from "$lib/blockchain-registry.js";

export interface ParsedSource {
  type: "cex" | "csv" | "etherscan" | "thegraph" | "btc" | "chain" | "manual" | "system" | "unknown";
  institutionId: string | null;
  chainId?: number;
  chainName?: string;
}

/** Direct chain source prefixes used by actual journal entry source strings */
const CHAIN_SOURCE_PREFIXES: Record<string, string> = {
  "bitcoin": "bitcoin", "solana": "sol", "ton": "ton", "aptos": "aptos",
  "sui": "sui", "stellar": "stellar", "polkadot": "polkadot", "tron": "tron",
  "cosmos": "cosmos", "xrp": "xrp", "cardano": "cardano", "near": "near",
  "algorand": "algorand", "kaspa": "kaspa", "stacks": "stacks", "zcash": "zcash",
  "hedera": "hedera", "bittensor": "bittensor", "monero": "xmr",
  "doge": "doge", "ltc": "ltc", "bch": "bch",
  "dash": "dash", "bsv": "bsv", "xec": "xec", "grs": "grs",
};

/** Task queue key prefixes (not used in journal entries, but in sync task keys) */
const CHAIN_SYNC_PREFIXES: Record<string, string> = {
  "sol-sync": "sol", "hl-sync": "hl", "sui-sync": "sui", "aptos-sync": "aptos",
  "ton-sync": "ton", "tezos-sync": "tezos", "cosmos-sync": "cosmos",
  "polkadot-sync": "polkadot", "doge-sync": "doge", "ltc-sync": "ltc",
  "bch-sync": "bch", "dash-sync": "dash", "bsv-sync": "bsv",
  "xec-sync": "xec", "grs-sync": "grs", "xrp-sync": "xrp", "tron-sync": "tron",
  "stellar-sync": "stellar", "bittensor-sync": "bittensor", "hedera-sync": "hedera",
  "near-sync": "near", "algorand-sync": "algorand", "kaspa-sync": "kaspa",
  "zcash-sync": "zcash", "stacks-sync": "stacks", "cardano-sync": "cardano",
  "xmr-sync": "xmr",
};

/** DeFi protocol name → governance/native token symbol */
const PROTOCOL_TOKEN: Record<string, string> = {
  "Uniswap": "UNI", "Aave": "AAVE", "Lido": "LDO", "Curve": "CRV",
  "Compound": "COMP", "MakerDAO/Spark": "MKR", "Yearn": "YFI",
  "Balancer": "BAL", "EigenLayer": "EIGEN", "Pendle": "PENDLE",
  "Jupiter": "JUP", "Raydium": "RAY", "Jito": "JTO", "Marinade": "MNDE",
  // Phase 1 — DEX/bridge forks
  "SushiSwap": "SUSHI", "PancakeSwap": "CAKE", "QuickSwap": "QUICK", "Camelot": "GRAIL",
  "Paraswap": "PSP", "Odos": "ODOS", "OpenOcean": "OOE",
  "Hop": "HOP", "Circle CCTP": "USDC",
  // Phase 2 — lending
  "Morpho": "MORPHO", "Liquity": "LQTY", "Venus": "XVS",
  // Phase 3 — yield/ve(3,3)
  "Convex": "CVX", "Aura": "AURA", "Aerodrome": "AERO", "Velodrome": "VELO",
  // Phase 4 — liquid staking
  "Rocket Pool": "RPL", "ether.fi": "ETHFI", "Kelp": "RSETH",
  "Renzo": "REZ", "Swell": "SWELL", "StakeWise": "SWISE",
  "Frax Ether": "FXS", "Ethena": "ENA",
  // Phase 5 — vault aggregators
  "Beefy": "BIFI", "Harvest": "FARM", "Sommelier": "SOMM", "Badger": "BADGER",
  // Phase 6 — reward claims
  "Merkl": "ANGLE", "Votium": "CVX",
  // Phase 7 — additional lending
  "Euler": "EUL", "Radiant": "RDNT", "Silo": "SILO",
  // Phase 8-12 — advanced protocols
  "GMX": "GMX", "Origin": "OGN", "Notional": "NOTE",
  "Synthetix": "SNX", "dYdX": "DYDX",
};

/** EVM L2 chain IDs — these keep their chain logo instead of native currency icon */
const EVM_L2_CHAIN_IDS = new Set([
  10, 42161, 8453, 59144, 534352, 81457,  // Optimism, Arbitrum, Base, Linea, Scroll, Blast
  5000, 252, 167000, 2741, 4326, 1923,     // Mantle, Fraxtal, Taiko, Abstract, MegaETH, Swellchain
  480, 130, 747474, 204,                     // World, Unichain, Katana, opBNB
  999, 33139, 9745, 4352,                    // HyperEVM, ApeChain, Plasma, Memecore
]);

/**
 * Parse an entry source string to identify its origin type and institution.
 */
export function parseSourceId(source: string): ParsedSource {
  if (!source) return { type: "unknown", institutionId: null };

  // CSV/OFX/PDF imports: "csv-import:presetId:sourceKey"
  if (source.startsWith("csv-import:")) {
    const parts = source.split(":");
    const presetId = parts[1] || null;
    return { type: "csv", institutionId: presetId };
  }
  if (source === "csv-import") return { type: "csv", institutionId: null };

  // Blockchain explorers: "etherscan:chainId:txHash"
  if (source.startsWith("etherscan:")) {
    const chainId = parseInt(source.split(":")[1]);
    return { type: "etherscan", institutionId: null, chainId: isNaN(chainId) ? undefined : chainId };
  }
  if (source.startsWith("thegraph:")) {
    const chainId = parseInt(source.split(":")[1]);
    return { type: "thegraph", institutionId: null, chainId: isNaN(chainId) ? undefined : chainId };
  }

  // Bitcoin sync task key: "btc-sync:accountId"
  if (source.startsWith("btc-sync:")) return { type: "btc", institutionId: null };

  // Manual and system
  if (source === "manual") return { type: "manual", institutionId: null };
  if (source.startsWith("system:")) return { type: "system", institutionId: null };

  // Hyperliquid: "hyperliquid:fill:hash", "hyperliquid:funding:key", "hyperliquid:ledger:hash"
  if (source.startsWith("hyperliquid:")) return { type: "chain", institutionId: null, chainName: "hl" };

  // Chain sync task keys: "sol-sync:id", "aptos-sync:id", etc.
  for (const [prefix, chainName] of Object.entries(CHAIN_SYNC_PREFIXES)) {
    if (source.startsWith(prefix + ":")) {
      return { type: "chain", institutionId: null, chainName };
    }
  }

  // Direct chain source strings: "bitcoin:txid", "solana:sig", "ton:eventId", etc.
  const colonIdx = source.indexOf(":");
  if (colonIdx > 0) {
    const prefix = source.slice(0, colonIdx);
    const chainName = CHAIN_SOURCE_PREFIXES[prefix];
    if (chainName) {
      return { type: "chain", institutionId: null, chainName };
    }

    // CEX adapter sync: "exchangeId:refid" (e.g., "kraken:TXID123")
    if (INSTITUTION_REGISTRY[prefix]) {
      return { type: "cex", institutionId: prefix };
    }
  }

  return { type: "unknown", institutionId: null };
}

/**
 * Get the best icon URL for a source (used for non-CoinIcon sources: CEX, CSV, L2 chains).
 */
export function getSourceIconUrl(source: string): string | null {
  const parsed = parseSourceId(source);

  // CEX: exchange favicon
  if (parsed.type === "cex" && parsed.institutionId) {
    const url = getExchangeIconUrl(parsed.institutionId);
    if (url) return url;
  }

  // CSV/OFX/PDF: check if preset has a matching exchange icon
  if (parsed.type === "csv" && parsed.institutionId) {
    const url = getExchangeIconUrl(parsed.institutionId);
    if (url) return url;
  }

  // Blockchain sources: use chain icon (for L2s and fallback)
  if (parsed.type === "etherscan" && parsed.chainId) return CHAIN_ICONS[parsed.chainId] ?? null;
  if (parsed.type === "thegraph" && parsed.chainId) return CHAIN_ICONS[parsed.chainId] ?? null;
  if (parsed.type === "btc") return NAMED_CHAIN_ICONS["bitcoin"] ?? null;
  if (parsed.type === "chain" && parsed.chainName) return NAMED_CHAIN_ICONS[parsed.chainName] ?? null;

  return null;
}

/**
 * Get a human-readable label for a source.
 */
export function getSourceLabel(source: string): string {
  const parsed = parseSourceId(source);

  if (parsed.institutionId) {
    // Try exchange name from adapters
    if (parsed.type === "cex") {
      const info = INSTITUTION_REGISTRY[parsed.institutionId];
      return info?.url?.replace(/\.com$|\.net$|\.io$|\.org$/, "").replace(/^www\./, "")
        ?? parsed.institutionId;
    }
    // CSV preset — use institution name or preset ID
    const info = INSTITUTION_REGISTRY[parsed.institutionId];
    if (info) {
      // Use short name from URL if available
      if (info.url) return info.url.replace(/^www\./, "");
      return info.legalEntity || parsed.institutionId;
    }
    return parsed.institutionId;
  }

  switch (parsed.type) {
    case "etherscan": return "Etherscan";
    case "thegraph": return "The Graph";
    case "btc": return "Bitcoin";
    case "chain": return parsed.chainName ?? "Blockchain";
    case "manual": return "Manual";
    case "system": return "System";
    default: return source.length > 20 ? source.slice(0, 20) + "\u2026" : source;
  }
}

/**
 * Get the protocol's governance/native token symbol from description_data.
 * Returns the token symbol (e.g., "UNI", "AAVE") or null if not a protocol tx.
 */
export function getProtocolToken(descriptionData?: string): string | null {
  if (!descriptionData) return null;
  try {
    const parsed = JSON.parse(descriptionData);
    if ((parsed.type === "defi" || parsed.type === "sol-defi") && parsed.protocol) {
      return PROTOCOL_TOKEN[parsed.protocol] ?? null;
    }
  } catch { /* invalid JSON — ignore */ }
  return null;
}

/**
 * Get a chain icon URL from description_data for CSV/import entries.
 * For onchain-transfer, cex-operation, and btc-transfer types, returns the chain icon.
 */
export function getDescriptionChainIcon(descriptionData?: string): string | null {
  if (!descriptionData) return null;
  try {
    const parsed = JSON.parse(descriptionData);
    if (parsed.type === "onchain-transfer" && parsed.chain) {
      return NAMED_CHAIN_ICONS[parsed.chain.toLowerCase()] ?? null;
    }
    if (parsed.type === "defi" && parsed.chain) {
      return NAMED_CHAIN_ICONS[parsed.chain.toLowerCase()] ?? null;
    }
    if (parsed.type === "cex-operation" && parsed.exchange) {
      return NAMED_CHAIN_ICONS[parsed.exchange.toLowerCase()] ?? null;
    }
    if (parsed.type === "btc-transfer") {
      return NAMED_CHAIN_ICONS["bitcoin"] ?? null;
    }
    if (parsed.type === "sol-transfer") {
      return NAMED_CHAIN_ICONS["solana"] ?? null;
    }
  } catch { /* invalid JSON — ignore */ }
  return null;
}

/**
 * Get the native currency symbol for an EVM L1 on-chain source.
 * Only returns a coin code for EVM L1 chains — non-EVM chains (Bitcoin, Solana,
 * Hyperliquid, etc.) already have reliable direct icon URLs in NAMED_CHAIN_ICONS,
 * so they fall through to getSourceIconUrl() instead of using CoinIcon.
 */
export function getSourceNativeCurrency(parsed: ParsedSource): string | null {
  if ((parsed.type === "etherscan" || parsed.type === "thegraph") && parsed.chainId) {
    const chain = SUPPORTED_CHAINS.find(c => c.chain_id === parsed.chainId);
    return chain?.native_currency ?? null;
  }

  return null;
}

/** Check if an EVM chain is an L2 (should show chain logo instead of native currency icon). */
export function isL2Chain(chainId: number): boolean {
  return EVM_L2_CHAIN_IDS.has(chainId);
}
