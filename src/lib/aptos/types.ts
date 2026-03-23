// Aptos account tracking and API response types.

export interface AptosAccount {
	id: string;
	address: string; // 0x + 64 hex chars (left-padded)
	label: string;
	last_version: number | null; // global tx version for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface AptosSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Indexer GraphQL Response Types ──────────────────────

export interface AptosActivity {
	transaction_version: number;
	event_index: number;
	block_height: number;
	transaction_timestamp: string; // ISO datetime
	type: string; // "0x1::coin::DepositEvent", "0x1::coin::WithdrawEvent", etc.
	amount: string | null;
	asset_type: string; // "0x1::aptos_coin::AptosCoin" etc.
	owner_address: string;
	entry_function_id_str: string | null; // "0x1::aptos_account::transfer" etc.
	is_gas_fee: boolean;
	is_transaction_success: boolean;
}

// ── REST API Types ──────────────────────────────────────

export interface AptosTransaction {
	version: string;
	hash: string;
	success: boolean;
	timestamp: string; // microseconds since epoch
	gas_used: string;
	payload?: {
		function?: string;
		type_arguments?: string[];
		arguments?: unknown[];
	};
	events?: AptosEvent[];
}

export interface AptosEvent {
	guid: { creation_number: string; account_address: string };
	sequence_number: string;
	type: string;
	data: Record<string, unknown>;
}
