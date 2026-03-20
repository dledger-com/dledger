export interface SolanaAccount {
  id: string;
  address: string;
  network: "mainnet-beta" | "devnet" | "testnet";
  label: string;
  last_signature: string | null;
  last_sync: string | null;
  created_at: string;
}

export interface SolanaSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

// Helius Enhanced Transaction types
export interface SolTxGroup {
  signature: string;
  timestamp: number;
  slot: number;
  fee: number; // lamports
  feePayer: string;
  status: "success" | "failed";
  nativeTransfers: SolNativeTransfer[];
  tokenTransfers: SolTokenTransfer[];
  instructions: SolInstruction[];
  type?: string; // Helius classification: TRANSFER, SWAP, etc.
  source?: string; // Helius source: JUPITER, RAYDIUM, etc.
}

export interface SolNativeTransfer {
  from: string;
  to: string;
  amount: number; // lamports
}

export interface SolTokenTransfer {
  from: string;
  to: string;
  mint: string;
  amount: string;
  decimals: number;
  tokenSymbol?: string;
}

export interface SolInstruction {
  programId: string;
  data?: string;
  accounts: string[];
  innerInstructions?: SolInstruction[];
}

export interface SolInputDetection {
  input_type: "address" | "keypair" | "seed" | "unknown";
  is_private: boolean;
  valid: boolean;
  word_count: number | null;
  description: string;
}
