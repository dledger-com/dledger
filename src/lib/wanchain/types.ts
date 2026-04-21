// Wanchain types — covers the tx/receipt/log shapes we care about.
// Docs: https://docs.wanchain.org/ — chain ID 888, native token WAN (18 decimals).

export interface WanchainSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

export interface WanchainInputDetection {
  input_type: "address" | "seed" | "unknown";
  is_private: boolean;
  valid: boolean;
  word_count: number | null;
  description: string;
}

/** JSON-RPC block with full transactions inlined. */
export interface RpcBlock {
  number: string;      // hex
  hash: string;
  timestamp: string;   // hex (unix seconds)
  transactions: RpcTx[];
}

export interface RpcTx {
  hash: string;
  blockNumber: string; // hex
  from: string;
  to: string | null;
  value: string;       // hex wei
  input: string;
  gas: string;
  gasPrice: string;
}

export interface RpcReceipt {
  transactionHash: string;
  blockNumber: string;
  gasUsed: string;     // hex
  effectiveGasPrice?: string;
  status: string;      // "0x1" success, "0x0" failed
  logs: RpcLog[];
}

export interface RpcLog {
  address: string;       // contract address
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  topics: string[];
  data: string;          // hex-encoded payload
  removed?: boolean;
}

/** Normalized WRC-20 Transfer event. */
export interface Wrc20Transfer {
  contract: string;
  from: string;
  to: string;
  value: string;         // decimal string (raw base units)
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

/** Aggregated per-hash: one tx + its WRC-20 logs + (optional) receipt. */
export interface WanchainTxGroup {
  hash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  to: string | null;
  value: string;         // decimal WAN in wei (raw)
  gasUsed: string;       // decimal gas units (raw)
  gasPrice: string;      // decimal wei
  success: boolean;
  tokenTransfers: Wrc20Transfer[];
}

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}
