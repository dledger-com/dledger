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
