// LLM prompt templates for plugin creation guidance.

export type SourceType = "csv" | "cex" | "defi" | "pdf";
export type DefiChainFamily = "evm" | "solana";

const CSV_PRESET_INTERFACE = `interface CsvRecord {
  date: string;           // YYYY-MM-DD
  description: string;
  descriptionData?: DescriptionData;  // structured description for UI rendering (optional)
  lines: { account: string; currency: string; amount: string }[];
  groupKey?: string;      // rows with the same groupKey are merged into one journal entry (e.g. trade legs)
  sourceKey?: string;     // unique dedup key — prevents re-importing the same record (e.g. transaction ID)
  metadata?: Record<string, string>;
}

// DescriptionData for bank imports:
// { type: "bank"; bank: string; text: string }
// Rendered as: "MyBank: Payment to X"

interface CsvImportOptions {
  delimiter?: string;           // default ","
  dateColumn: string;           // column header name
  descriptionColumn?: string;   // column header name
  dateFormat?: string;          // "YYYY-MM-DD" (default), "MM/DD/YYYY", "DD/MM/YYYY", "ISO8601"
  lines: CsvColumnMapping[];    // each maps columns → a line item (UI-configured, rarely set by preset)
}

interface CsvFileHeader {
  mainAccount?: string;
  accountMetadata?: Record<string, string>;
  balanceDate?: string;
  balanceAmount?: string;
  balanceCurrency?: string;
}

interface CsvPreset {
  id: string;
  name: string;
  description: string;
  suggestedMainAccount?: string;
  detect(headers: string[], sampleRows: string[][]): number;  // 0-100 confidence
  getDefaultMapping(headers: string[]): Partial<CsvImportOptions>;  // pre-populate UI mapping
  transform(headers: string[], rows: string[][]): CsvRecord[] | null;
  parseFileHeader?(headers: string[], rows: string[][]): CsvFileHeader | null;  // optional: extract metadata from CSV preamble
}`;

const CSV_EXAMPLE = `// CSV preset example — a bank import
const preset = {
  id: "my-bank",
  name: "My Bank",
  description: "Import CSV from My Bank",
  suggestedMainAccount: "Assets:Bank:MyBank",

  detect(headers, sampleRows) {
    // Return 0-100 based on how well headers match this bank's format
    const hasDate = headers.some(h => h.toLowerCase().includes("date"));
    const hasAmount = headers.some(h => h.toLowerCase().includes("amount"));
    const hasBankSpecific = headers.some(h => h === "Transaction Reference");
    return hasDate && hasAmount && hasBankSpecific ? 85 : 0;
  },

  getDefaultMapping(headers) {
    // Pre-populate the mapping UI with detected columns
    return {
      dateColumn: "Date",
      descriptionColumn: "Description",
      dateFormat: "DD/MM/YYYY",
    };
  },

  transform(headers, rows) {
    const dateIdx = headers.indexOf("Date");
    const descIdx = headers.indexOf("Description");
    const amountIdx = headers.indexOf("Amount");
    if (dateIdx < 0 || amountIdx < 0) return null;

    return rows.map(row => {
      const description = row[descIdx] || "";
      return {
        date: row[dateIdx],
        description,
        descriptionData: { type: "bank", bank: "My Bank", text: description },
        lines: [
          { account: "Assets:Bank:MyBank", currency: "EUR", amount: row[amountIdx] },
          { account: "Expenses:Uncategorized", currency: "EUR",
            amount: String(-Number(row[amountIdx])) },
        ],
        sourceKey: row[headers.indexOf("Transaction Reference")] || undefined,
      };
    });
  },
};`;

const CEX_ADAPTER_INTERFACE = `interface CexLedgerRecord {
  refid: string;         // globally unique ID for dedup — must not repeat across calls
  type: "trade" | "deposit" | "withdrawal" | "transfer" | "staking" | "other";
  asset: string;         // normalized symbol (e.g. "BTC")
  amount: string;        // positive for receives, the sign depends on type
  fee: string;           // always positive or "0"
  timestamp: number;     // Unix seconds
  txid: string | null;   // blockchain txid if applicable
  metadata?: Record<string, string>;
  // Trade metadata conventions:
  //   "trade:symbol": "BTCUSDT"
  //   "trade:side": "buy" | "sell"
  //   "trade:price": "42000.50"
  //   "trade:quantity": "0.5"
  //   "trade:orderId": "123456"
  //   "fee:currency": "BTC"  (if fee is in a different asset)
}

interface CexAdapter {
  exchangeId: string;            // lowercase identifier, e.g. "my-exchange"
  exchangeName: string;          // display name
  requiresPassphrase?: boolean;  // true if API requires a passphrase (e.g. OKX)
  normalizeAsset(raw: string): string;
  fetchLedgerRecords(apiKey: string, apiSecret: string, since?: number, signal?: AbortSignal, passphrase?: string): Promise<CexLedgerRecord[]>;
}

// Available browser globals in plugin scope:
//   fetch() — HTTP requests (use for API calls)
//   crypto.subtle — HMAC signing (crypto.subtle.importKey + crypto.subtle.sign)
//   AbortSignal — check signal?.aborted before each API call
//   TextEncoder — for encoding strings to Uint8Array for HMAC`;

const CEX_EXAMPLE = `// CEX adapter example with authentication and pagination
const adapter = {
  exchangeId: "my-exchange",
  exchangeName: "My Exchange",

  normalizeAsset(raw) {
    // Map exchange-specific asset codes to standard symbols
    const map = { "XBT": "BTC", "IOTA": "MIOTA" };
    return map[raw] || raw.toUpperCase();
  },

  async fetchLedgerRecords(apiKey, apiSecret, since, signal) {
    const records = [];
    let cursor = null;

    // HMAC-SHA256 signing helper
    async function sign(message) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw", encoder.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
      return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    // Paginated fetch loop
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const timestamp = String(Date.now());
      const path = "/api/v1/ledger";
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      if (since) params.set("since", String(since));

      const queryString = params.toString();
      const signature = await sign(timestamp + "GET" + path + "?" + queryString);

      const resp = await fetch("https://api.my-exchange.com" + path + "?" + queryString, {
        headers: {
          "X-API-KEY": apiKey,
          "X-TIMESTAMP": timestamp,
          "X-SIGNATURE": signature,
        },
        signal,
      });
      if (!resp.ok) throw new Error("API error: " + resp.status + " " + (await resp.text()));

      const data = await resp.json();
      for (const item of data.records) {
        records.push({
          refid: item.id,
          type: mapType(item.type),  // "trade", "deposit", etc.
          asset: this.normalizeAsset(item.currency),
          amount: item.amount,
          fee: item.fee || "0",
          timestamp: Math.floor(new Date(item.time).getTime() / 1000),
          txid: item.txid || null,
          metadata: item.type === "trade" ? {
            "trade:symbol": item.symbol,
            "trade:side": item.side,
            "trade:price": item.price,
            "trade:quantity": item.qty,
          } : undefined,
        });
      }

      cursor = data.nextCursor;
      if (!cursor || data.records.length === 0) break;
    }

    return records;
  },
};

function mapType(raw) {
  const map = { "TRADE": "trade", "DEPOSIT": "deposit", "WITHDRAW": "withdrawal",
                "TRANSFER": "transfer", "STAKING": "staking" };
  return map[raw] || "other";
}`;

const DEFI_HANDLER_INTERFACE = `// ---- Data shapes ----

// A TxHashGroup contains all transactions sharing the same hash:
interface TxHashGroup {
  hash: string;
  timestamp: string;              // Unix seconds as string
  normal: NormalTx | null;        // the main transaction (null if only internal/token txs)
  internals: InternalTx[];        // internal (trace) transactions
  erc20s: Erc20Tx[];              // ERC-20 token transfers
  erc721s: Erc721Tx[];            // ERC-721 NFT transfers
  erc1155s: Erc1155Tx[];          // ERC-1155 multi-token transfers
}

interface NormalTx {
  hash: string; timeStamp: string; from: string; to: string;
  value: string;   // wei as decimal string
  isError: string; // "0" = success, "1" = reverted
  gasUsed: string; gasPrice: string;
  functionName?: string;
}

interface Erc20Tx {
  hash: string; timeStamp: string; from: string; to: string;
  value: string;           // raw amount (no decimals applied)
  contractAddress: string; // token contract
  tokenName: string; tokenSymbol: string;
  tokenDecimal: string;    // e.g. "18", "6"
}

interface InternalTx {
  hash: string; timeStamp: string; from: string; to: string;
  value: string; isError: string;
}

// ---- Handler interface ----

interface TransactionHandler {
  id: string;
  name: string;
  description: string;
  website?: string;
  supportedChainIds: number[];  // list ALL chain IDs the protocol is deployed on (shown in UI)

  match(group: TxHashGroup, ctx: HandlerContext): number;     // 0-100 confidence
  process(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult>;
}

// ---- Context passed to your handler ----

interface HandlerContext {
  address: string;       // user's wallet address
  chainId: number;       // e.g. 1, 42161, 8453
  label: string;         // user's label for this wallet
  chain: {
    name: string;              // e.g. "Ethereum", "Arbitrum One"
    native_currency: string;   // e.g. "ETH"
    decimals: number;          // e.g. 18
  };
  // Create account/currency if they don't exist yet:
  ensureAccount(fullName: string, date: string): Promise<string>;    // returns account_id
  ensureCurrency(code: string, decimals: number, contractAddress?: string): Promise<void>;
}

// ---- Return types ----

type HandlerResult =
  | { type: "entries"; entries: HandlerEntry[] }
  | { type: "skip"; reason: string };

interface HandlerEntry {
  entry: {
    date: string;               // YYYY-MM-DD
    description: string;        // human-readable fallback
    description_data?: string;  // JSON.stringify of DescriptionData (see below)
    status: "confirmed";
    source: string;             // format: "etherscan:{chainId}:{txHash}"
    voided_by: null;
  };
  items: LineItem[];            // must sum to zero per currency (double-entry)
  metadata: Record<string, string>;
}
// IMPORTANT: Create exactly ONE HandlerEntry per TxHashGroup. The source field
// ("etherscan:{chainId}:{hash}") is used for dedup — multiple entries with the
// same source will conflict. Combine all token flows AND gas fees into a single
// entry's items array.

// Line items — the core of double-entry bookkeeping:
interface LineItem {
  account_id: string;   // from ctx.ensureAccount()
  currency: string;     // e.g. "ETH", "USDC"
  amount: string;       // positive = debit, negative = credit; string for precision
  lot_id: string | null; // null for most cases
}

// DescriptionData for DeFi handlers:
// { type: "defi", protocol: "MyProtocol", action: "Deposit", chain: "Ethereum", txHash: "0x...", summary?: "MyProtocol (Ethereum): Deposit 1.5 ETH" }
// The summary is displayed in the UI. If omitted, rendered as "{protocol} ({chain}): {action}".

// ---- Account path conventions ----
// Assets:Crypto:DeFi:{Protocol}:{Type}     — e.g. "Assets:Crypto:DeFi:Aave:Supply"
// Liabilities:Crypto:DeFi:{Protocol}:{Type} — e.g. "Liabilities:Crypto:DeFi:Aave:Borrow"
// Income:Crypto:DeFi:{Protocol}:{Type}      — e.g. "Income:Crypto:DeFi:Aave:Interest"
// Expenses:Crypto:DeFi:{Protocol}:{Type}    — e.g. "Expenses:Crypto:DeFi:Aave:Interest"
// Expenses:Crypto:Fees:{ChainName}          — gas fees
// Assets:Crypto:Wallet:{ChainName}:{Label}  — user's wallet

// ---- Metadata conventions ----
// handler: "my-protocol"                    — handler id
// handler:action: "DEPOSIT"                 — action classification

// ---- Match score guidelines ----
// 55-60: standard protocol handler
// 50:    generic/fallback handler
// 65+:   only for very specific sub-protocol forks

// ---- Chain IDs (common values) ----
// 1=Ethereum, 10=Optimism, 56=BSC, 137=Polygon, 250=Fantom, 324=zkSync Era,
// 8453=Base, 42161=Arbitrum One, 43114=Avalanche, 59144=Linea, 534352=Scroll
// Always list the specific chains your protocol is deployed on in supportedChainIds.`;

const DEFI_EXAMPLE = `// Complete DeFi handler example — a lending protocol with deposits, withdrawals, and swaps
// IMPORTANT: Exactly ONE HandlerEntry per transaction hash. All token flows + gas go in one entry.

// Known contract addresses (always lowercase for comparison)
const CONTRACTS = {
  VAULT: "0x1234567890abcdef1234567890abcdef12345678",
  ROUTER: "0xabcdef1234567890abcdef1234567890abcdef12",
};

function isProtocolContract(addr) {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === CONTRACTS.VAULT || a === CONTRACTS.ROUTER;
}

// Convert raw token value (BigInt string) to decimal string
function formatTokenAmount(value, decimals) {
  if (!value || value === "0") return "0";
  const d = parseInt(decimals) || 18;
  const s = value.padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d) || "0";
  const frac = s.slice(s.length - d).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

// Convert Unix timestamp to YYYY-MM-DD
function tsToDate(ts) {
  return new Date(parseInt(ts) * 1000).toISOString().slice(0, 10);
}

const handler = {
  id: "my-protocol",
  name: "My Protocol",
  description: "Handles My Protocol lending deposits, withdrawals, and swaps",
  website: "https://myprotocol.xyz",
  supportedChainIds: [1, 42161],  // Ethereum + Arbitrum

  match(group, ctx) {
    // Check the main transaction target
    if (group.normal && isProtocolContract(group.normal.to)) return 60;
    // Check ERC-20 transfers involving our contracts
    if (group.erc20s.some(tx =>
      isProtocolContract(tx.to) || isProtocolContract(tx.from)
    )) return 55;
    return 0;
  },

  async process(group, ctx) {
    const addr = ctx.address.toLowerCase();
    const date = tsToDate(group.timestamp);
    const chainName = ctx.chain.name;

    // ---- Analyze ERC-20 token flows relative to user ----
    const deposited = [];   // user → protocol
    const withdrawn = [];   // protocol → user
    for (const tx of group.erc20s) {
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();
      if (from === addr && isProtocolContract(to)) deposited.push(tx);
      else if (isProtocolContract(from) && to === addr) withdrawn.push(tx);
    }

    // Classify action
    let action, actionLabel;
    if (deposited.length > 0 && withdrawn.length === 0) {
      action = "DEPOSIT"; actionLabel = "Deposit";
    } else if (withdrawn.length > 0 && deposited.length === 0) {
      action = "WITHDRAW"; actionLabel = "Withdrawal";
    } else if (deposited.length > 0 && withdrawn.length > 0) {
      action = "SWAP"; actionLabel = "Swap";
    } else {
      return { type: "skip", reason: "no token movement detected" };
    }

    // ---- Build a SINGLE entry with ALL items (tokens + gas) ----
    const items = [];

    // Token flow items
    if (action === "DEPOSIT") {
      for (const tx of deposited) {
        const symbol = tx.tokenSymbol;
        const amount = formatTokenAmount(tx.value, tx.tokenDecimal);
        await ctx.ensureCurrency(symbol, parseInt(tx.tokenDecimal), tx.contractAddress);
        const defiId   = await ctx.ensureAccount("Assets:Crypto:DeFi:MyProtocol:Supply", date);
        const walletId = await ctx.ensureAccount("Assets:Crypto:Wallet:" + chainName + ":" + ctx.label, date);
        items.push(
          { account_id: defiId,   currency: symbol, amount: amount,       lot_id: null },
          { account_id: walletId, currency: symbol, amount: "-" + amount, lot_id: null },
        );
      }
    } else if (action === "WITHDRAW") {
      for (const tx of withdrawn) {
        const symbol = tx.tokenSymbol;
        const amount = formatTokenAmount(tx.value, tx.tokenDecimal);
        await ctx.ensureCurrency(symbol, parseInt(tx.tokenDecimal), tx.contractAddress);
        const defiId   = await ctx.ensureAccount("Assets:Crypto:DeFi:MyProtocol:Supply", date);
        const walletId = await ctx.ensureAccount("Assets:Crypto:Wallet:" + chainName + ":" + ctx.label, date);
        items.push(
          { account_id: walletId, currency: symbol, amount: amount,       lot_id: null },
          { account_id: defiId,   currency: symbol, amount: "-" + amount, lot_id: null },
        );
      }
    } else if (action === "SWAP") {
      const walletId = await ctx.ensureAccount("Assets:Crypto:Wallet:" + chainName + ":" + ctx.label, date);
      for (const tx of deposited) {
        const symbol = tx.tokenSymbol;
        const amount = formatTokenAmount(tx.value, tx.tokenDecimal);
        await ctx.ensureCurrency(symbol, parseInt(tx.tokenDecimal), tx.contractAddress);
        items.push({ account_id: walletId, currency: symbol, amount: "-" + amount, lot_id: null });
      }
      for (const tx of withdrawn) {
        const symbol = tx.tokenSymbol;
        const amount = formatTokenAmount(tx.value, tx.tokenDecimal);
        await ctx.ensureCurrency(symbol, parseInt(tx.tokenDecimal), tx.contractAddress);
        items.push({ account_id: walletId, currency: symbol, amount: amount, lot_id: null });
      }
    }

    // Gas fee items — include in the SAME entry, not a separate one
    if (group.normal && group.normal.gasUsed && group.normal.gasPrice) {
      const gasCost = (BigInt(group.normal.gasUsed) * BigInt(group.normal.gasPrice)).toString();
      const gasAmount = formatTokenAmount(gasCost, ctx.chain.decimals);
      if (gasAmount !== "0") {
        const native = ctx.chain.native_currency;
        await ctx.ensureCurrency(native, ctx.chain.decimals);
        const walletId = await ctx.ensureAccount("Assets:Crypto:Wallet:" + chainName + ":" + ctx.label, date);
        const feeId    = await ctx.ensureAccount("Expenses:Crypto:Fees:" + chainName, date);
        items.push(
          { account_id: feeId,    currency: native, amount: gasAmount,       lot_id: null },
          { account_id: walletId, currency: native, amount: "-" + gasAmount, lot_id: null },
        );
      }
    }

    if (items.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    // Build summary for description
    let summary;
    if (action === "SWAP" && deposited.length > 0 && withdrawn.length > 0) {
      const inStr  = deposited.map(tx => formatTokenAmount(tx.value, tx.tokenDecimal) + " " + tx.tokenSymbol).join(" + ");
      const outStr = withdrawn.map(tx => formatTokenAmount(tx.value, tx.tokenDecimal) + " " + tx.tokenSymbol).join(" + ");
      summary = "My Protocol (" + chainName + "): Swap " + inStr + " → " + outStr;
    } else {
      const txs = action === "DEPOSIT" ? deposited : withdrawn;
      const parts = txs.map(tx => formatTokenAmount(tx.value, tx.tokenDecimal) + " " + tx.tokenSymbol);
      summary = "My Protocol (" + chainName + "): " + actionLabel + " " + parts.join(", ");
    }

    const descData = {
      type: "defi", protocol: "My Protocol", action: actionLabel,
      chain: chainName, txHash: group.hash, summary,
    };

    return {
      type: "entries",
      entries: [{
        entry: {
          date,
          description: summary,
          description_data: JSON.stringify(descData),
          status: "confirmed",
          source: "etherscan:" + ctx.chainId + ":" + group.hash,
          voided_by: null,
        },
        items,
        metadata: {
          "handler": "my-protocol",
          "handler:action": action,
        },
      }],
    };
  },
};`;

const SOLANA_HANDLER_INTERFACE = `// ---- Data shapes ----

// A SolTxGroup represents a single Solana transaction (from the Helius Enhanced API):
interface SolTxGroup {
  signature: string;
  timestamp: number;          // Unix seconds
  slot: number;
  fee: number;                // lamports (1 SOL = 1_000_000_000 lamports)
  feePayer: string;
  status: "success" | "failed";
  nativeTransfers: SolNativeTransfer[];
  tokenTransfers: SolTokenTransfer[];
  instructions: SolInstruction[];
  type?: string;              // Helius classification: "TRANSFER", "SWAP", "BURN", etc.
  source?: string;            // Helius source: "JUPITER", "RAYDIUM", "MARINADE", etc.
}

interface SolNativeTransfer {
  from: string;
  to: string;
  amount: number;             // lamports
}

interface SolTokenTransfer {
  from: string;
  to: string;
  mint: string;               // SPL token mint address
  amount: string;             // raw amount as string
  decimals: number;
  tokenSymbol?: string;       // may be absent for unknown tokens
}

interface SolInstruction {
  programId: string;
  data?: string;
  accounts: string[];
  innerInstructions?: SolInstruction[];
}

// ---- Handler interface ----

interface SolanaHandler {
  id: string;
  name: string;
  description: string;

  match(tx: SolTxGroup, ctx: SolanaHandlerContext): number;     // 0-100 confidence
  process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult>;
}

// ---- Context passed to your handler ----

interface SolanaHandlerContext {
  address: string;       // user's wallet address
  label: string;         // user's label for this wallet
  // Create account/currency if they don't exist yet:
  ensureAccount(fullName: string, date: string): Promise<string>;    // returns account_id
  ensureCurrency(code: string, decimals: number, mintAddress?: string): Promise<void>;
}

// ---- Return types (same as EVM) ----

type HandlerResult =
  | { type: "entries"; entries: HandlerEntry[] }
  | { type: "skip"; reason: string };

interface HandlerEntry {
  entry: {
    date: string;               // YYYY-MM-DD
    description: string;        // human-readable fallback
    description_data?: string;  // JSON.stringify of DescriptionData (see below)
    status: "confirmed";
    source: string;             // format: "solana:{signature}"
    voided_by: null;
  };
  items: LineItem[];            // must sum to zero per currency (double-entry)
  metadata: Record<string, string>;
}
// IMPORTANT: Create exactly ONE HandlerEntry per SolTxGroup. The source field
// ("solana:{signature}") is used for dedup — multiple entries with the same
// source will conflict. Combine all token flows AND fee into a single
// entry's items array.

interface LineItem {
  account_id: string;   // from ctx.ensureAccount()
  currency: string;     // e.g. "SOL", "USDC"
  amount: string;       // positive = debit, negative = credit; string for precision
  lot_id: string | null; // null for most cases
}

// DescriptionData for Solana DeFi handlers:
// { type: "solana-defi", protocol: "MyProtocol", action: "swap", signature: "...", summary?: "MyProtocol (Solana): Swap 1.5 SOL → 100 USDC" }
// The summary is displayed in the UI. If omitted, rendered as "{protocol} (Solana): {action}".

// ---- Account path conventions ----
// Assets:Crypto:DeFi:{Protocol}:{Type}     — e.g. "Assets:Crypto:DeFi:Jupiter:Swap"
// Income:Crypto:DeFi:{Protocol}:{Type}      — e.g. "Income:Crypto:DeFi:Marinade:Staking"
// Expenses:Crypto:DeFi:{Protocol}:{Type}
// Expenses:Crypto:Fees:Solana               — transaction fees
// Assets:Crypto:Wallet:Solana:{Label}       — user's wallet

// ---- Matching strategies ----
// 1. tx.source === "YOUR_PROTOCOL" — best for protocols classified by Helius
//    Known Helius source values: JUPITER, RAYDIUM, MARINADE, ORCA, TENSOR, METAPLEX, etc.
// 2. tx.instructions.some(ix => ix.programId === "YOUR_PROGRAM_ID") — match by program ID
// 3. Combine both for maximum reliability

// ---- Match score guidelines ----
// 55-60: standard protocol handler
// 50:    generic/fallback handler
// 65+:   only for very specific sub-protocol forks`;

const SOLANA_DEFI_EXAMPLE = `// Complete Solana DeFi handler example — a swap protocol
// IMPORTANT: Exactly ONE HandlerEntry per transaction. All token flows + fee go in one entry.

const PROTOCOL_PROGRAM = "Proto111111111111111111111111111111111111111";

// Convert raw token value to decimal string (no external deps)
function formatAmount(value, decimals) {
  if (!value || value === "0") return "0";
  const s = String(value).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

// Convert lamports to SOL string
function lamportsToSol(lamports) {
  return formatAmount(String(Math.abs(lamports)), 9);
}

// Convert Unix timestamp to YYYY-MM-DD
function tsToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

const handler = {
  id: "my-protocol",
  name: "My Protocol",
  description: "Handles My Protocol swaps on Solana",

  match(tx, ctx) {
    if (tx.status === "failed") return 0;
    // Strategy 1: Helius source classification
    if (tx.source === "MY_PROTOCOL") return 55;
    // Strategy 2: match by program ID
    if (tx.instructions.some(ix => ix.programId === PROTOCOL_PROGRAM)) return 55;
    return 0;
  },

  async process(tx, ctx) {
    const addr = ctx.address;
    const date = tsToDate(tx.timestamp);
    const items = [];

    const walletAccount = "Assets:Crypto:Wallet:Solana:" + ctx.label;

    // ---- Analyze SPL token flows ----
    const inflows = [];   // tokens received by user
    const outflows = [];  // tokens sent by user

    for (const t of tx.tokenTransfers) {
      const symbol = t.tokenSymbol || t.mint.slice(0, 6);
      const amount = formatAmount(t.amount, t.decimals);

      if (t.from === addr && t.to !== addr) {
        outflows.push({ symbol, amount, mint: t.mint, decimals: t.decimals });
      } else if (t.to === addr && t.from !== addr) {
        inflows.push({ symbol, amount, mint: t.mint, decimals: t.decimals });
      }
    }

    // ---- Analyze native SOL flows (excluding fee) ----
    let netLamports = 0;
    for (const nt of tx.nativeTransfers) {
      if (nt.from === addr && nt.to !== addr) netLamports -= nt.amount;
      else if (nt.to === addr && nt.from !== addr) netLamports += nt.amount;
    }
    if (netLamports !== 0) {
      const solAmount = lamportsToSol(netLamports);
      if (netLamports > 0) {
        inflows.push({ symbol: "SOL", amount: solAmount, mint: "SOL", decimals: 9 });
      } else {
        outflows.push({ symbol: "SOL", amount: solAmount, mint: "SOL", decimals: 9 });
      }
    }

    if (inflows.length === 0 && outflows.length === 0) {
      return { type: "skip", reason: "no token movement detected" };
    }

    // ---- Ensure currencies ----
    for (const flow of [...inflows, ...outflows]) {
      await ctx.ensureCurrency(flow.symbol, flow.decimals, flow.mint === "SOL" ? undefined : flow.mint);
    }

    // ---- Build swap items ----
    const walletId = await ctx.ensureAccount(walletAccount, date);
    const defiId = await ctx.ensureAccount("Assets:Crypto:DeFi:MyProtocol:Swap", date);

    for (const outflow of outflows) {
      items.push(
        { account_id: walletId, currency: outflow.symbol, amount: "-" + outflow.amount, lot_id: null },
        { account_id: defiId, currency: outflow.symbol, amount: outflow.amount, lot_id: null },
      );
    }
    for (const inflow of inflows) {
      items.push(
        { account_id: walletId, currency: inflow.symbol, amount: inflow.amount, lot_id: null },
        { account_id: defiId, currency: inflow.symbol, amount: "-" + inflow.amount, lot_id: null },
      );
    }

    // ---- Fee ----
    if (tx.feePayer === addr && tx.fee > 0) {
      await ctx.ensureCurrency("SOL", 9);
      const feeAmount = lamportsToSol(tx.fee);
      const feeId = await ctx.ensureAccount("Expenses:Crypto:Fees:Solana", date);
      items.push(
        { account_id: feeId, currency: "SOL", amount: feeAmount, lot_id: null },
        { account_id: walletId, currency: "SOL", amount: "-" + feeAmount, lot_id: null },
      );
    }

    // ---- Build entry ----
    const spentStr = outflows.map(o => o.amount + " " + o.symbol).join(", ") || "?";
    const receivedStr = inflows.map(i => i.amount + " " + i.symbol).join(", ") || "?";
    const summary = "My Protocol (Solana): Swap " + spentStr + " → " + receivedStr;

    const descData = {
      type: "solana-defi", protocol: "My Protocol", action: "swap",
      signature: tx.signature, summary,
    };

    return {
      type: "entries",
      entries: [{
        entry: {
          date,
          description: summary,
          description_data: JSON.stringify(descData),
          status: "confirmed",
          source: "solana:" + tx.signature,
          voided_by: null,
        },
        items,
        metadata: {
          "sol:signature": tx.signature,
          "sol:slot": String(tx.slot),
          "sol:timestamp": String(tx.timestamp),
          "sol:fee_lamports": String(tx.fee),
          "sol:handler": "my-protocol",
        },
      }],
    };
  },
};`;

const PDF_PARSER_INTERFACE = `// Each text item has x,y coordinates — use x position to distinguish columns
// (e.g., dates at x < 100, descriptions at 100 < x < 400, amounts at x > 400)
interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

interface PdfTextLine {
  y: number;
  items: PdfTextItem[];
}

interface PdfPage {
  pageNumber: number;
  lines: PdfTextLine[];
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
  presetId: string;      // for source-based dedup (e.g. "pdf-my-bank")
  detect(pages: PdfPage[]): number;   // 0-100 confidence
  parse(pages: PdfPage[]): PdfStatement;
  suggestAccount?(statement: PdfStatement): string;  // optional
}`;

const PDF_EXAMPLE = `// PDF parser example — a bank statement
// For complex layouts, use item.x coordinates to identify columns instead of regex.

function parseMyBankStatement(pages) {
  const transactions = [];
  let txIndex = 0;

  for (const page of pages) {
    for (const line of page.lines) {
      // Join all text items on the line
      const text = line.items.map(i => i.str).join(" ").trim();

      // Try to match a transaction line: "DD/MM/YYYY Description 1,234.56"
      const match = text.match(/^(\\d{2}\\/\\d{2}\\/\\d{4})\\s+(.+?)\\s+(-?[\\d,.]+)$/);
      if (match) {
        const [, dateStr, desc, amountStr] = match;
        const [day, month, year] = dateStr.split("/");
        transactions.push({
          date: year + "-" + month + "-" + day,
          description: desc.trim(),
          amount: parseFloat(amountStr.replace(/,/g, "")),
          index: txIndex++,
        });
      }
    }
  }

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
}

const parser = {
  id: "pdf-my-bank",
  name: "My Bank Statement",
  presetId: "pdf-my-bank",

  detect(pages) {
    // Best pattern: try parsing and score by result quality
    try {
      const result = parseMyBankStatement(pages);
      if (result.transactions.length > 0) return 80;
    } catch { /* not this bank */ }
    return 0;
  },

  parse(pages) {
    return parseMyBankStatement(pages);
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

const PII_NOTICE = `
IMPORTANT — DO NOT INCLUDE ANY PERSONAL DATA IN THE PLUGIN CODE.
The sample data I paste above may contain real personal information (names, IBANs, account/card numbers, references, merchants, addresses, wallet addresses, etc.). Use it only to understand the format. The plugin code you produce — including any tests, examples, comments, default values, hardcoded strings, or fixtures — must contain ZERO real PII. Replace every real value with an obviously synthetic placeholder (e.g. "JANE DOE", "EXAMPLE BANK", checksum-invalid IBANs like "FR00…", "0000…" references, round neutral amounts). If you are unsure whether a string is synthetic, treat it as PII and replace it.`;

const SANDBOX_NOTICE = `
IMPORTANT: Plugin code runs in a sandboxed scope with NO access to imports or modules.
Available: all browser globals (fetch, crypto.subtle, BigInt, Date, JSON, TextEncoder, etc.).
For DeFi handlers: the \`ctx\` object passed to process() provides ensureAccount() and ensureCurrency().
Do NOT use import/export/require statements or top-level await.
The code must work when evaluated with \`new Function('exports', code)\`.
Use \`exports.plugin = plugin\` at the end to export your plugin.`;

function sourceTypeLabel(type: SourceType): string {
  switch (type) {
    case "csv": return "CSV import";
    case "cex": return "exchange API";
    case "defi": return "DeFi handler";
    case "pdf": return "PDF parser";
  }
}

export function generateLlmPrompt(type: SourceType, url?: string, defiChain?: DefiChainFamily): string {
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
      parts.push(`The exchange website: ${url ?? "[URL]"}`);
      parts.push("");
      parts.push("Please visit the website above, find the exchange name and API documentation, then implement a CexAdapter with proper authentication and pagination.");
      parts.push("Use crypto.subtle for HMAC signing (it's available as a browser global).");
      parts.push("Check signal?.aborted before each API call to support cancellation.");
      break;

    case "defi":
      if (defiChain === "solana") {
        parts.push("## Interfaces to implement");
        parts.push("```typescript");
        parts.push(SOLANA_HANDLER_INTERFACE);
        parts.push("```");
        parts.push("");
        parts.push("## Complete working example");
        parts.push("```javascript");
        parts.push(SOLANA_DEFI_EXAMPLE);
        parts.push("```");
        parts.push("");
        parts.push("## Protocol details");
        parts.push(`The protocol website: ${url ?? "[URL]"}`);
        parts.push("The program ID(s): [...]");
        parts.push("What it does: [DESCRIBE: swaps, lending, staking, etc.]");
        parts.push("");
        parts.push("Please visit the website above, find the protocol name and relevant documentation, then implement a SolanaHandler that matches and processes these transactions.");
        parts.push("Follow the example closely — use the exact same data shapes for entries, items, metadata, and description_data.");
        parts.push("CRITICAL: Create exactly ONE HandlerEntry per transaction. Combine all token flows AND fee into a single entry's items array (see example). The source field is used for dedup — multiple entries with the same source will conflict.");
        parts.push("Use ctx.ensureAccount() for every account and ctx.ensureCurrency() for every token before referencing them in items.");
        parts.push("Match by tx.source (Helius classification) and/or programId for maximum reliability.");
      } else {
        parts.push("## Interfaces to implement");
        parts.push("```typescript");
        parts.push(DEFI_HANDLER_INTERFACE);
        parts.push("```");
        parts.push("");
        parts.push("## Complete working example");
        parts.push("```javascript");
        parts.push(DEFI_EXAMPLE);
        parts.push("```");
        parts.push("");
        parts.push("## Protocol details");
        parts.push(`The protocol website: ${url ?? "[URL]"}`);
        parts.push("The contract address(es): [0x...]");
        parts.push("The chain: [Ethereum/Polygon/Arbitrum/etc.]");
        parts.push("What it does: [DESCRIBE: swaps, lending, staking, etc.]");
        parts.push("");
        parts.push("Please visit the website above, find the protocol name and relevant documentation, then implement a TransactionHandler that matches and processes these transactions.");
        parts.push("Follow the example closely — use the exact same data shapes for entries, items, metadata, and description_data.");
        parts.push("CRITICAL: Create exactly ONE HandlerEntry per transaction hash. Combine all token flows AND gas fee into a single entry's items array (see example). The source field is used for dedup — multiple entries with the same source will conflict.");
        parts.push("Use ctx.ensureAccount() for every account and ctx.ensureCurrency() for every token before referencing them in items.");
      }
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
      parts.push("Detection tip: try parsing the PDF and score by transaction count (see example).");
      break;
  }

  parts.push("");
  parts.push("## Plugin wrapper");
  parts.push("Wrap everything in this plugin object and export it:");
  parts.push("```typescript");
  if (type === "defi" && defiChain === "solana") {
    parts.push(`// Wrap your implementation in a Plugin object:
const plugin = {
  id: "com.example.my-plugin",   // use reverse-domain naming
  name: "My Plugin",
  version: "1.0.0",
  description: "Description of what this plugin does",
  solanaHandlers: [{ handler, programIds: ["Proto111..."] }],
};

exports.plugin = plugin;`);
  } else {
    parts.push(PLUGIN_WRAPPER.trim());
  }
  parts.push("```");
  parts.push("");
  parts.push(SANDBOX_NOTICE.trim());
  parts.push("");
  parts.push(PII_NOTICE.trim());

  return parts.join("\n");
}
