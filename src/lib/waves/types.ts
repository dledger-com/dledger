// Waves blockchain types — covers the tx shapes we import.
// Full schemas: https://docs.waves.tech/en/blockchain/transaction-type/

export interface WavesSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

export interface WavesInputDetection {
  input_type: "address" | "seed" | "unknown";
  is_private: boolean;
  valid: boolean;
  word_count: number | null;
  description: string;
}

// ── Asset metadata ──────────────────────────────────────

export interface WavesAssetDetails {
  assetId: string;
  name: string;
  description: string;
  decimals: number;
  issuer: string;
  quantity: number;
  reissuable: boolean;
  /** Optional ticker set by the issuer (rarely present). */
  ticker?: string;
}

// ── Common transaction fields ───────────────────────────

export interface WavesTxBase {
  id: string;
  type: number;
  version?: number;
  sender: string;
  senderPublicKey: string;
  fee: number;
  feeAssetId: string | null;
  timestamp: number;
  height?: number;
  /** "succeeded" or "script_execution_failed" */
  applicationStatus?: string;
  chainId?: number;
}

// ── Type 4 — Transfer ───────────────────────────────────

export interface WavesTransferTx extends WavesTxBase {
  type: 4;
  recipient: string;
  amount: number;
  assetId: string | null;
  attachment?: string;
}

// ── Type 7 — Exchange (matcher-settled trade) ───────────

export interface WavesOrder {
  id?: string;
  orderType: "buy" | "sell";
  sender: string;
  senderPublicKey: string;
  matcherPublicKey: string;
  assetPair: { amountAsset: string | null; priceAsset: string | null };
  price: number;
  amount: number;
  timestamp: number;
  expiration?: number;
  matcherFee: number;
  matcherFeeAssetId?: string | null;
}

export interface WavesExchangeTx extends WavesTxBase {
  type: 7;
  order1: WavesOrder;
  order2: WavesOrder;
  price: number;
  amount: number;
  buyMatcherFee: number;
  sellMatcherFee: number;
}

// ── Type 8/9 — Lease / LeaseCancel ──────────────────────

export interface WavesLeaseTx extends WavesTxBase {
  type: 8;
  recipient: string;
  amount: number;
}

export interface WavesLeaseCancelTx extends WavesTxBase {
  type: 9;
  leaseId: string;
  /** Echoed back for convenience by some nodes. */
  lease?: { amount: number; recipient: string; sender: string };
}

// ── Type 11 — MassTransfer ──────────────────────────────

export interface WavesMassTransferEntry {
  recipient: string;
  amount: number;
}

export interface WavesMassTransferTx extends WavesTxBase {
  type: 11;
  assetId: string | null;
  transfers: WavesMassTransferEntry[];
  /** Total quantity moved (sum of transfers). Some nodes omit it. */
  totalAmount?: number;
  attachment?: string;
}

// ── Type 16 — InvokeScript ──────────────────────────────

export interface WavesPayment {
  amount: number;
  assetId: string | null;
}

export interface WavesStateTransfer {
  address: string;
  asset: string | null;
  amount: number;
}

export interface WavesStateChanges {
  transfers?: WavesStateTransfer[];
  /** Other state-change arrays (data, issues, burns, ...) are ignored. */
  [k: string]: unknown;
}

export interface WavesInvokeScriptTx extends WavesTxBase {
  type: 16;
  dApp: string;
  call?: { function: string; args?: unknown[] };
  payment?: WavesPayment[];
  /** Present when the node attaches execution details to the tx. */
  stateChanges?: WavesStateChanges;
}

// ── Type 18 — Ethereum-like (rare in personal wallets) ──

export interface WavesEthereumTx extends WavesTxBase {
  type: 18;
  payload:
    | { type: "transfer"; recipient: string; asset: string | null; amount: number }
    | { type: "invocation"; dApp: string; call?: { function: string; args?: unknown[] }; payment?: WavesPayment[] };
}

// ── Union of all supported types ────────────────────────

export type WavesTransaction =
  | WavesTransferTx
  | WavesExchangeTx
  | WavesLeaseTx
  | WavesLeaseCancelTx
  | WavesMassTransferTx
  | WavesInvokeScriptTx
  | WavesEthereumTx
  | (WavesTxBase & { type: number });
