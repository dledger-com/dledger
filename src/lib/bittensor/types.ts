// Bittensor account tracking and Subscan API response types.

export interface BittensorAccount {
	id: string;
	address: string; // SS58 format (starts with 5, generic Substrate prefix 42)
	label: string;
	last_page: number | null; // Subscan pagination cursor
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface BittensorSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Subscan API Response Types (same as Polkadot) ──────────────────────────

export interface BittensorTransfer {
	from: string;
	to: string;
	module: string; // "balances"
	amount: string; // in rao (1 TAO = 10^9 rao)
	success: boolean;
	hash: string;
	block_num: number;
	block_timestamp: number; // unix seconds
	fee: string; // in rao
	extrinsic_index: string; // "blockNum-idx"
}

export interface BittensorReward {
	event_index: string; // "blockNum-idx"
	block_num: number;
	extrinsic_idx: number;
	module_id: string; // "subtensormodule"
	event_id: string; // "Rewarded" or similar
	amount: string; // in rao
	block_timestamp: number; // unix seconds
}
