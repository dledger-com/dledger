// Polkadot account tracking and Subscan API response types.

export interface PolkadotAccount {
	id: string;
	address: string; // SS58 format (starts with 1 for DOT)
	label: string;
	last_page: number | null; // Subscan pagination cursor
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface PolkadotSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── Subscan API Response Types ──────────────────────────

export interface SubscanTransfer {
	from: string;
	to: string;
	module: string; // "balances"
	amount: string; // in Plancks
	success: boolean;
	hash: string;
	block_num: number;
	block_timestamp: number; // unix seconds
	fee: string; // in Plancks
	extrinsic_index: string; // "blockNum-idx"
}

export interface SubscanReward {
	event_index: string; // "blockNum-idx"
	block_num: number;
	extrinsic_idx: number;
	module_id: string; // "staking"
	event_id: string; // "Rewarded" or "Slashed"
	amount: string; // in Plancks
	block_timestamp: number; // unix seconds
}
