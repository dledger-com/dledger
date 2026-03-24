// NEAR account tracking and NEAR Blocks API response types.

export interface NearAccount {
	id: string;
	address: string; // Named (alice.near) or implicit (64-char hex)
	label: string;
	last_cursor: string | null; // Pagination cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface NearSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── NEAR Blocks API Response Types ──────────────────────────

export interface NearTransaction {
	transaction_hash: string;
	block_timestamp: string; // nanoseconds since epoch
	signer_account_id: string;
	receiver_account_id: string;
	actions: NearAction[];
	outcomes: NearOutcome;
}

export interface NearAction {
	action: string; // "TRANSFER", "FUNCTION_CALL", "CREATE_ACCOUNT", etc.
	method?: string; // for FUNCTION_CALL
	deposit?: string; // yoctoNEAR
	args?: string; // base64 encoded
}

export interface NearOutcome {
	status: boolean;
}

export interface NearTransactionListResponse {
	txns: NearTransaction[];
	cursor: string | null;
}
