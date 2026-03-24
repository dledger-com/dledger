// Hedera account tracking and Mirror Node API response types.

export interface HederaAccount {
	id: string;
	address: string; // 0.0.{number} format
	label: string;
	last_timestamp: string | null; // Consensus timestamp cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface HederaSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Mirror Node API Response Types ──────────────────────────

export interface HederaTransaction {
	transaction_id: string;
	consensus_timestamp: string; // "seconds.nanoseconds"
	name: string; // "CRYPTOTRANSFER", "CONTRACTCALL", etc.
	result: string; // "SUCCESS", "INSUFFICIENT_PAYER_BALANCE", etc.
	charged_tx_fee: number; // in tinybar
	transfers: HederaTransfer[];
	token_transfers: HederaTokenTransfer[];
}

export interface HederaTransfer {
	account: string; // "0.0.X"
	amount: number; // in tinybar, signed
	is_approval: boolean;
}

export interface HederaTokenTransfer {
	account: string;
	amount: number;
	token_id: string;
	is_approval: boolean;
}

export interface HederaTransactionListResponse {
	transactions: HederaTransaction[];
	links: { next: string | null };
}
