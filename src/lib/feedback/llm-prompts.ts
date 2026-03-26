// LLM prompt templates for plugin creation guidance.

export type SourceType = "csv" | "cex" | "defi" | "pdf";

const CSV_PRESET_INTERFACE = `interface CsvRecord {
  date: string;           // YYYY-MM-DD
  description: string;
  lines: { account: string; currency: string; amount: string }[];
  groupKey?: string;      // group related rows (e.g. trades)
  sourceKey?: string;     // dedup key
  metadata?: Record<string, string>;
}

interface CsvPreset {
  id: string;
  name: string;
  description: string;
  suggestedMainAccount?: string;
  detect(headers: string[], sampleRows: string[][]): number;  // 0-100 confidence
  getDefaultMapping(headers: string[]): Record<string, unknown>;
  transform(headers: string[], rows: string[][]): CsvRecord[] | null;
}`;

const CSV_EXAMPLE = `// Minimal CSV preset example
const preset = {
  id: "my-bank",
  name: "My Bank",
  description: "Import CSV from My Bank",
  suggestedMainAccount: "Assets:Bank:MyBank",

  detect(headers, sampleRows) {
    // Return 0-100 based on how well headers match
    const found = headers.some(h => h.toLowerCase().includes("date"))
      && headers.some(h => h.toLowerCase().includes("amount"));
    return found ? 80 : 0;
  },

  getDefaultMapping(headers) {
    return {};
  },

  transform(headers, rows) {
    return rows.map(row => {
      const date = row[0];  // adjust column index
      const desc = row[1];
      const amount = row[2];
      return {
        date,
        description: desc,
        lines: [
          { account: "Assets:Bank:MyBank", currency: "EUR", amount },
          { account: "Expenses:Uncategorized", currency: "EUR", amount: String(-Number(amount)) },
        ],
      };
    });
  },
};`;

const CEX_ADAPTER_INTERFACE = `interface CexLedgerRecord {
  refid: string;         // unique ID for dedup
  type: "trade" | "deposit" | "withdrawal" | "transfer" | "staking" | "other";
  asset: string;         // normalized symbol (e.g. "BTC")
  amount: string;
  fee: string;
  timestamp: number;     // Unix seconds
  txid: string | null;   // blockchain txid if applicable
  metadata?: Record<string, string>;
}

interface CexAdapter {
  exchangeId: string;
  exchangeName: string;
  requiresPassphrase?: boolean;
  normalizeAsset(raw: string): string;
  fetchLedgerRecords(apiKey: string, apiSecret: string, since?: number, signal?: AbortSignal, passphrase?: string): Promise<CexLedgerRecord[]>;
}`;

const CEX_EXAMPLE = `// Minimal CEX adapter example
const adapter = {
  exchangeId: "my-exchange",
  exchangeName: "My Exchange",

  normalizeAsset(raw) {
    return raw.toUpperCase();
  },

  async fetchLedgerRecords(apiKey, apiSecret, since, signal) {
    // Implement API calls here with authentication
    // Use pagination to fetch all records
    // Return normalized CexLedgerRecord[]
    const records = [];
    // ... fetch from API ...
    return records;
  },
};`;

const DEFI_HANDLER_INTERFACE = `interface TransactionHandler {
  id: string;
  name: string;
  description: string;
  website?: string;
  supportedChainIds: number[];  // empty = all chains

  match(group: TxHashGroup, ctx: HandlerContext): number;     // 0-100 confidence
  process(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult>;
}

// TxHashGroup contains: hash, normalTxs, internalTxs, erc20Txs, erc721Txs, erc1155Txs
// HandlerContext contains: address, chainId, label, chain, backend, settings
// HandlerResult: { type: "entries"; entries: HandlerEntry[] } | { type: "skip"; reason: string }
// HandlerEntry: { entry: { date, description, status, source }, items: LineItem[], metadata: {} }`;

const DEFI_EXAMPLE = `// Minimal DeFi handler example
const handler = {
  id: "my-protocol",
  name: "My Protocol",
  description: "Handles My Protocol transactions",
  website: "https://myprotocol.xyz",
  supportedChainIds: [1],  // Ethereum mainnet

  match(group, ctx) {
    // Check if any transaction interacts with your protocol's contract
    const CONTRACT = "0x1234...".toLowerCase();
    const hits = group.normalTxs.some(tx => tx.to.toLowerCase() === CONTRACT)
      || group.erc20Txs.some(tx => tx.contractAddress.toLowerCase() === CONTRACT);
    return hits ? 60 : 0;
  },

  async process(group, ctx) {
    // Build ledger entries from the transaction group
    const entries = [];
    // ... analyze group.normalTxs, group.erc20Txs, etc.
    return { type: "entries", entries };
  },
};`;

const PDF_PARSER_INTERFACE = `interface PdfPage {
  pageNumber: number;
  lines: PdfTextLine[];
}

interface PdfTextLine {
  y: number;
  items: { str: string; x: number; y: number; width: number; height: number; fontName: string }[];
}

interface PdfTransaction {
  date: string;          // YYYY-MM-DD
  description: string;
  amount: number;
  index: number;
  metadata?: Record<string, string>;
}

interface PdfStatement {
  accountNumber: string | null;
  iban: string | null;
  currency: string;
  openingBalance: number | null;
  openingDate: string | null;
  closingBalance: number | null;
  closingDate: string | null;
  transactions: PdfTransaction[];
  warnings: string[];
}

interface PdfParserExtension {
  id: string;
  name: string;
  presetId: string;      // for source-based dedup
  detect(pages: PdfPage[]): number;   // 0-100 confidence
  parse(pages: PdfPage[]): PdfStatement;
  suggestAccount?(statement: PdfStatement): string;
}`;

const PDF_EXAMPLE = `// Minimal PDF parser example
const parser = {
  id: "pdf-my-bank",
  name: "My Bank Statement",
  presetId: "pdf-my-bank",

  detect(pages) {
    // Check if this PDF is from your bank
    const firstPageText = pages[0]?.lines.map(l => l.items.map(i => i.str).join(" ")).join(" ") ?? "";
    return firstPageText.includes("My Bank Name") ? 80 : 0;
  },

  parse(pages) {
    const transactions = [];
    // ... parse each page's lines by coordinates ...
    return {
      accountNumber: null,
      iban: null,
      currency: "EUR",
      openingBalance: null,
      openingDate: null,
      closingBalance: null,
      closingDate: null,
      transactions,
      warnings: [],
    };
  },

  suggestAccount() {
    return "Assets:Bank:MyBank";
  },
};`;

const PLUGIN_WRAPPER = `
// Wrap your implementation in a Plugin object:
const plugin = {
  id: "com.example.my-plugin",   // use reverse-domain naming
  name: "My Plugin",
  version: "1.0.0",
  description: "Description of what this plugin does",
  // Include only the relevant field:
  // csvPresets: [preset],
  // cexAdapters: [adapter],
  // transactionHandlers: [{ handler, hints: { addresses: ["0x..."] } }],
  // pdfParsers: [parser],
};

exports.plugin = plugin;
`;

function sourceTypeLabel(type: SourceType): string {
  switch (type) {
    case "csv": return "CSV import";
    case "cex": return "exchange API";
    case "defi": return "DeFi handler";
    case "pdf": return "PDF parser";
  }
}

export function generateLlmPrompt(type: SourceType): string {
  const parts: string[] = [];

  parts.push(`I need help creating a dLedger ${sourceTypeLabel(type)} plugin.`);
  parts.push("");

  switch (type) {
    case "csv":
      parts.push("## Interfaces to implement");
      parts.push("```typescript");
      parts.push(CSV_PRESET_INTERFACE);
      parts.push("```");
      parts.push("");
      parts.push("## Example");
      parts.push("```typescript");
      parts.push(CSV_EXAMPLE);
      parts.push("```");
      parts.push("");
      parts.push("## My CSV file");
      parts.push("Here are the first rows of my CSV (headers + 3-5 data rows):");
      parts.push("```");
      parts.push("[PASTE YOUR CSV ROWS HERE]");
      parts.push("```");
      parts.push("");
      parts.push("The bank/exchange name is: [NAME]");
      parts.push("The currency is: [CURRENCY CODE, e.g. EUR, USD]");
      parts.push("The main account should be: [e.g. Assets:Bank:MyBank]");
      parts.push("");
      parts.push("Please implement a CsvPreset that can detect and parse this CSV format.");
      break;

    case "cex":
      parts.push("## Interfaces to implement");
      parts.push("```typescript");
      parts.push(CEX_ADAPTER_INTERFACE);
      parts.push("```");
      parts.push("");
      parts.push("## Example");
      parts.push("```typescript");
      parts.push(CEX_EXAMPLE);
      parts.push("```");
      parts.push("");
      parts.push("## Exchange details");
      parts.push("The exchange name is: [NAME]");
      parts.push("The exchange website/API documentation: [URL]");
      parts.push("");
      parts.push("Please look up the API documentation from the URL above and implement a CexAdapter with proper authentication and pagination.");
      break;

    case "defi":
      parts.push("## Interfaces to implement");
      parts.push("```typescript");
      parts.push(DEFI_HANDLER_INTERFACE);
      parts.push("```");
      parts.push("");
      parts.push("## Example");
      parts.push("```typescript");
      parts.push(DEFI_EXAMPLE);
      parts.push("```");
      parts.push("");
      parts.push("## Protocol details");
      parts.push("The protocol name is: [NAME]");
      parts.push("The protocol website/docs: [URL]");
      parts.push("The contract address(es): [0x...]");
      parts.push("The chain: [Ethereum/Polygon/Arbitrum/etc.]");
      parts.push("What it does: [DESCRIBE: swaps, lending, staking, etc.]");
      parts.push("");
      parts.push("Please look up the protocol from the URL above and implement a TransactionHandler that matches and processes these transactions.");
      break;

    case "pdf":
      parts.push("## Interfaces to implement");
      parts.push("```typescript");
      parts.push(PDF_PARSER_INTERFACE);
      parts.push("```");
      parts.push("");
      parts.push("## Example");
      parts.push("```typescript");
      parts.push(PDF_EXAMPLE);
      parts.push("```");
      parts.push("");
      parts.push("The bank name is: [NAME]");
      parts.push("The statement layout: [DESCRIBE: column positions, date format, amount format]");
      parts.push("");
      parts.push("Please implement a PdfParserExtension that can detect and parse these statements.");
      break;
  }

  parts.push("");
  parts.push("## Plugin wrapper");
  parts.push("Wrap everything in this plugin object and export it:");
  parts.push("```typescript");
  parts.push(PLUGIN_WRAPPER.trim());
  parts.push("```");
  parts.push("");
  parts.push("IMPORTANT: The code must work when evaluated with `new Function('exports', code)`. Use `exports.plugin = plugin` at the end. Do not use import/export statements or top-level await.");

  return parts.join("\n");
}
