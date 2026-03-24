// Kaspa account tracking and Kaspa REST API response types.

export interface KaspaAccount {
	id: string;
	address: string; // Bech32 with kaspa: prefix
	label: string;
	last_cursor: string | null; // Pagination cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface KaspaSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Kaspa REST API Response Types ──────────────────────────

export interface KaspaTransaction {
	transaction_id: string;
	block_time: number; // unix milliseconds
	inputs: KaspaInput[];
	outputs: KaspaOutput[];
	is_accepted: boolean;
}

export interface KaspaInput {
	previous_outpoint_hash: string;
	previous_outpoint_index: number;
	previous_outpoint_address: string;
	previous_outpoint_amount: number; // sompi
}

export interface KaspaOutput {
	script_public_key_address: string;
	amount: number; // sompi
}
