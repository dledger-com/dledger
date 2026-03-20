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
