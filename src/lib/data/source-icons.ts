/**
 * Parse journal entry source strings and resolve to icon URLs.
 * Priority: ExchangeIcon (CoinGecko) > favicon > ChainIcon > fallback.
 */
import { INSTITUTION_REGISTRY, type InstitutionInfo } from "$lib/cex/institution-registry.js";
import { EXCHANGE_ICONS } from "$lib/data/exchange-icons.js";
import { CHAIN_ICONS, NAMED_CHAIN_ICONS } from "$lib/data/chain-icons.js";

export interface ParsedSource {
  type: "cex" | "csv" | "etherscan" | "thegraph" | "btc" | "chain" | "manual" | "system" | "recurring" | "unknown";
  institutionId: string | null;
  chainId?: number;
  chainName?: string;
}

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

  // Bitcoin sync: "btc-sync:accountId"
  if (source.startsWith("btc-sync:")) return { type: "btc", institutionId: null };

  // Manual and system
  if (source === "manual") return { type: "manual", institutionId: null };
  if (source.startsWith("system:")) return { type: "system", institutionId: null };
  if (source.startsWith("recurring:")) return { type: "recurring", institutionId: null };

  // Blockchain chain syncs: "sol-sync:id", "aptos-sync:id", etc.
  const CHAIN_SYNC_PREFIXES: Record<string, string> = {
    "sol-sync": "sol", "hl-sync": "hl", "sui-sync": "sui", "aptos-sync": "aptos",
    "ton-sync": "ton", "tezos-sync": "tezos", "cosmos-sync": "cosmos",
    "polkadot-sync": "polkadot", "doge-sync": "doge", "ltc-sync": "ltc",
    "bch-sync": "bch", "xrp-sync": "xrp", "tron-sync": "tron",
    "stellar-sync": "stellar", "bittensor-sync": "bittensor", "hedera-sync": "hedera",
    "near-sync": "near", "algorand-sync": "algorand", "kaspa-sync": "kaspa",
    "zcash-sync": "zcash", "stacks-sync": "stacks", "cardano-sync": "cardano",
    "xmr-sync": "xmr",
  };
  for (const [prefix, chainName] of Object.entries(CHAIN_SYNC_PREFIXES)) {
    if (source.startsWith(prefix + ":")) {
      return { type: "chain", institutionId: null, chainName };
    }
  }

  // CEX adapter sync: "exchangeId:refid" (e.g., "kraken:TXID123")
  const colonIdx = source.indexOf(":");
  if (colonIdx > 0) {
    const prefix = source.slice(0, colonIdx);
    // Check both institution registry and exchange icons
    if (INSTITUTION_REGISTRY[prefix] || EXCHANGE_ICONS[prefix]) {
      return { type: "cex", institutionId: prefix };
    }
  }

  return { type: "unknown", institutionId: null };
}

/**
 * Get the best icon URL for a source.
 * Priority: CoinGecko exchange icon > favicon > chain icon > null
 */
export function getSourceIconUrl(source: string): string | null {
  const parsed = parseSourceId(source);

  // CEX: prefer CoinGecko exchange icon (higher quality)
  if (parsed.type === "cex" && parsed.institutionId) {
    const exchangeUrl = EXCHANGE_ICONS[parsed.institutionId];
    if (exchangeUrl) return exchangeUrl;
    // Fallback to favicon
    const info = INSTITUTION_REGISTRY[parsed.institutionId];
    if (info?.url) return `https://www.google.com/s2/favicons?domain=${info.url}&sz=32`;
  }

  // CSV/OFX/PDF: check if preset has a matching CEX icon, then favicon
  if (parsed.type === "csv" && parsed.institutionId) {
    // Some CSV presets match exchange IDs (e.g., "kraken" preset)
    const exchangeUrl = EXCHANGE_ICONS[parsed.institutionId];
    if (exchangeUrl) return exchangeUrl;
    // Try institution registry for favicon
    const info = INSTITUTION_REGISTRY[parsed.institutionId];
    if (info?.url) return `https://www.google.com/s2/favicons?domain=${info.url}&sz=32`;
  }

  // Blockchain sources: use chain icon
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
    case "recurring": return "Recurring";
    default: return source.length > 20 ? source.slice(0, 20) + "\u2026" : source;
  }
}
