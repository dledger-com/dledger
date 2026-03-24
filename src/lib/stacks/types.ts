// Stacks account tracking and Hiro API response types.

export interface StacksAccount {
	id: string;
	address: string; // Base58Check, starts with SP
	label: string;
	last_offset: number | null; // Pagination offset for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface StacksSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Hiro Stacks API Response Types ──────────────────────────

export interface StacksTransaction {
	tx_id: string;
	tx_type: string; // "token_transfer", "contract_call", "smart_contract", "coinbase", "poison_microblock"
	tx_status: string; // "success", "abort_by_response", "abort_by_post_condition"
	burn_block_time: number; // unix seconds
	fee_rate: string; // microSTX
	sender_address: string;
	token_transfer?: StacksTokenTransfer;
	contract_call?: StacksContractCall;
}

export interface StacksTokenTransfer {
	recipient_address: string;
	amount: string; // microSTX
	memo: string; // hex-encoded memo
}

export interface StacksContractCall {
	contract_id: string;
	function_name: string;
	function_args: Array<{
		name: string;
		type: string;
		repr: string;
	}>;
}

export interface StacksTransactionListResponse {
	results: StacksTransaction[];
	total: number;
	limit: number;
	offset: number;
}
