export interface BitcoinAccount {
  id: string;
  address_or_xpub: string;
  account_type: "address" | "xpub" | "ypub" | "zpub";
  derivation_bip?: number;  // 44, 49, 84, 86
  network: "mainnet" | "testnet";
  label: string;
  last_receive_index: number;
  last_change_index: number;
  last_sync: string | null;
  created_at: string;
}

export interface BitcoinSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  addresses_derived: number;
  warnings: string[];
}

// Mempool.space API response types
export interface BtcApiTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number; block_height?: number };
  vin: BtcApiInput[];
  vout: BtcApiOutput[];
  fee: number; // satoshis
}

export interface BtcApiInput {
  txid: string;
  vout: number;
  prevout: { scriptpubkey_address: string; value: number } | null;
}

export interface BtcApiOutput {
  scriptpubkey_address: string;
  value: number; // satoshis
  n: number;
}

export interface BtcInputDetection {
  input_type: "address" | "xpub" | "ypub" | "zpub" | "wif" | "xprv" | "yprv" | "zprv" | "seed" | "unknown";
  is_private: boolean;
  network: "mainnet" | "testnet" | "unknown";
  suggested_bip: number | null;
  description: string;
  valid: boolean;
  word_count: number | null;
  invalid_words: string[] | null;
}

export type PublicResult =
  | { kind: "Address"; address: string }
  | { kind: "Xpub"; xpub: string; key_type: string };

export interface PrivateKeyConversion {
  input_type: string;
  public_result: PublicResult;
  network: string;
  suggested_bip: number;
}
