// Cardano account tracking types.

export interface CardanoAccount {
	id: string;
	address: string; // Bech32, starts with addr1
	label: string;
	last_page: number | null; // Blockfrost pagination page for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface CardanoSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Blockfrost API Response Types ──────────────────────────

export interface BlockfrostAddressTx {
	tx_hash: string;
	tx_index: number;
	block_height: number;
	block_time: number; // unix seconds
}

export interface BlockfrostUtxos {
	hash: string;
	inputs: BlockfrostUtxoEntry[];
	outputs: BlockfrostUtxoEntry[];
}

export interface BlockfrostUtxoEntry {
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	tx_hash: string;
	output_index: number;
}

export interface BlockfrostTxInfo {
	hash: string;
	block_time: number;
	fees: string; // lovelace
}
