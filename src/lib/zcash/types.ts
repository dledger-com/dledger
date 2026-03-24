// Zcash account tracking and Blockchair API response types (transparent only).

export interface ZcashAccount {
	id: string;
	address: string; // Transparent: t1... (P2PKH) or t3... (P2SH)
	label: string;
	last_cursor: string | null; // Pagination cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface ZcashSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Blockchair API Response Types ──────────────────────────

export interface BlockchairZcashResponse {
	data: {
		[address: string]: {
			address: {
				balance: number;
				transaction_count: number;
			};
			transactions: BlockchairZcashTransaction[];
		};
	};
}

export interface BlockchairZcashTransaction {
	hash: string;
	time: string; // ISO datetime
	balance_change: number; // satoshi, signed (positive = received, negative = sent)
}
