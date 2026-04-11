import type { TransactionHandler, HandlerContext } from "../handlers/types.js";
import type { CsvPreset } from "../csv-presets/types.js";
import type { CexAdapter } from "../cex/types.js";
import type { PdfPage, PdfStatement } from "../pdf/types.js";
import type { ChainInfo } from "../types/index.js";
import type { SolanaHandler } from "../solana/handlers/types.js";

// ---------------------------------------------------------------------------
// Plugin top-level
// ---------------------------------------------------------------------------

export interface Plugin {
  id: string;           // reverse-domain: "com.example.sushiswap"
  name: string;
  version: string;
  description?: string;

  // Extension contributions (include only the ones this plugin provides)
  transactionHandlers?: TransactionHandlerExtension[];
  solanaHandlers?: SolanaHandlerExtension[];
  csvPresets?: CsvPreset[];
  pdfParsers?: PdfParserExtension[];
  cexAdapters?: CexAdapter[];
  rateSources?: RateSourceExtension[];
  blockchainSources?: BlockchainSourceExtension[];
}

// ---------------------------------------------------------------------------
// Transaction handler hints for indexed matching
// ---------------------------------------------------------------------------

export interface HandlerHints {
  addresses?: string[];          // known contract addresses (lowercase)
  addressPrefixes?: string[];    // e.g., "0x111111" for 1inch
  tokenSymbols?: string[];       // e.g., ["stETH", "wstETH"]
  tokenPatterns?: RegExp[];      // e.g., /^PT-|^YT-|^SY-/ for Pendle
}

export interface TransactionHandlerExtension {
  handler: TransactionHandler;
  hints?: HandlerHints;          // omit = universal (always a candidate)
}

export interface SolanaHandlerExtension {
  handler: SolanaHandler;
  programIds?: string[];         // omit = universal (always a candidate)
}

// ---------------------------------------------------------------------------
// PDF parser extension
// ---------------------------------------------------------------------------

export interface PdfParserExtension {
  id: string;                           // "pdf-n26"
  name: string;                         // "N26 Bank Statement"
  presetId: string;                     // for source-based dedup
  detect(pages: PdfPage[]): number;     // 0-100 confidence
  parse(pages: PdfPage[]): PdfStatement;
  suggestAccount?(statement: PdfStatement): string;
}

// ---------------------------------------------------------------------------
// Blockchain source extension (plugin-provided chains)
// ---------------------------------------------------------------------------

export interface BlockchainSourceExtension {
  chainId: string;                // unique, e.g. "fantom"
  chainName: string;              // display: "Fantom"
  symbol: string;                 // native token: "FTM"
  coingeckoId?: string;           // for native token icon via CoinGecko API (also used as chain icon)
  iconUrl?: string;               // direct chain icon URL (highest priority)
  website?: string;               // protocol website — favicon used as fallback icon
  addressRegex: string;           // regex as string (compiled at registration)
  addressPlaceholder: string;     // "0x..."
  caseSensitive?: boolean;

  /** Optional config fields the user must provide (e.g. API key). */
  requiredConfig?: { key: string; label: string; placeholder?: string }[];

  /** Fetch one page of transactions. Framework handles pagination loop + cursor storage. */
  fetchTransactions(
    address: string,
    cursor: string | null,
    config: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<BlockchainFetchResult>;

  /** Classify one raw tx into journal line items. Return null to skip. */
  processTransaction(
    tx: BlockchainRawTransaction,
    ctx: BlockchainProcessContext,
  ): BlockchainProcessedTransaction | null;
}

export interface BlockchainFetchResult {
  transactions: BlockchainRawTransaction[];
  nextCursor: string | null;
}

export interface BlockchainRawTransaction {
  id: string;              // unique tx identifier (hash, signature, etc.)
  timestamp: number;       // Unix seconds
  data: unknown;           // opaque — passed to processTransaction
}

export interface BlockchainProcessContext {
  address: string;
  label: string;
  chainName: string;
  symbol: string;
}

export interface BlockchainProcessedTransaction {
  source: string;          // dedup key, e.g. "fantom:0xabc..."
  date: string;            // YYYY-MM-DD
  description: string;
  descriptionData?: string; // JSON-stringified DescriptionData
  items: { account: string; currency: string; amount: string }[];
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Rate source extension
// ---------------------------------------------------------------------------

export interface RateSourceExtension {
  sourceId: string;                     // "frankfurter"
  name: string;
  priority: number;                     // higher = tried first
  canHandle(currency: string, assetType: string, baseCurrency: string): boolean;
  fetchRates(
    currency: string,
    baseCurrency: string,
    dates: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, number>>;
}

// ---------------------------------------------------------------------------
// Plugin handler context (restricted — no backend/settings)
// ---------------------------------------------------------------------------

export interface PluginHandlerContext {
  address: string;
  chainId: number;
  label: string;
  chain: ChainInfo;
  enrichment: boolean;
  ensureAccount(fullName: string, date: string): Promise<string>;
  ensureCurrency(code: string, decimals: number, contractAddress?: string): Promise<void>;
}
