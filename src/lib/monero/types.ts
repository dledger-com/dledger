// Monero account tracking types.

export interface MoneroAccount {
	id: string;
	address: string; // Monero Base58, starts with 4
	view_key: string; // 64-char hex private view key
	label: string;
	last_sync_height: number | null; // Block height cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface MoneroSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Monero Light Wallet Server (MyMonero-compatible) API Types ──────

export interface LwsTransaction {
	id: number;
	hash: string;
	timestamp: string; // ISO or unix
	total_received: string; // piconero
	total_sent: string; // piconero
	height: number;
	payment_id: string;
	unlock_time: number;
	mempool: boolean;
}

export interface LwsAddressTxsResponse {
	total_received: string;
	scanned_height: number;
	scanned_block_height: number;
	start_height: number;
	blockchain_height: number;
	transactions: LwsTransaction[];
}
