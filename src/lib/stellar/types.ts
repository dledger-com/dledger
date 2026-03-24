// Stellar account tracking and API response types.

export interface StellarAccount {
	id: string;
	address: string; // StrKey G-address (Base32, starts with 'G')
	label: string;
	last_cursor: string | null; // Horizon paging_token for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface StellarSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Horizon API Response Types ───────────────────────────

export interface StellarOperation {
	id: string; // unique operation ID (used as paging_token)
	paging_token: string;
	transaction_hash: string;
	transaction_successful: boolean;
	type: string; // "payment", "create_account", "path_payment_strict_receive", etc.
	created_at: string; // ISO datetime
	source_account: string;

	// Payment / path_payment fields
	from?: string;
	to?: string;
	amount?: string; // decimal string (7 decimal places for XLM)
	asset_type?: string; // "native", "credit_alphanum4", "credit_alphanum12"
	asset_code?: string; // e.g., "USDC" (absent for native XLM)
	asset_issuer?: string;

	// create_account fields
	account?: string; // newly created account
	funder?: string;
	starting_balance?: string;
}

export interface StellarOperationListResponse {
	_embedded: {
		records: StellarOperation[];
	};
	_links: {
		next?: { href: string };
	};
}

export interface StellarInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}
