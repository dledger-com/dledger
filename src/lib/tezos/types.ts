// Tezos account tracking and TzKT API response types.

export interface TezosAccount {
	id: string;
	address: string; // tz1.../tz2.../KT1... format
	label: string;
	last_id: number | null; // TzKT operation ID cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface TezosSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── TzKT API Types ──────────────────────────────────────

export interface TezosOperation {
	type: string; // "transaction", "delegation", "origination", etc.
	id: number; // unique operation ID (cursor)
	level: number; // block level
	timestamp: string; // ISO datetime
	hash: string; // operation hash
	sender: { address: string; alias?: string };
	target?: { address: string; alias?: string };
	amount: number; // in mutez (XTZ * 10^6)
	bakerFee: number;
	storageFee: number;
	status: string; // "applied", "failed", "backtracked", "skipped"
	hasInternals: boolean;
}

export interface TezosTokenTransfer {
	id: number;
	level: number;
	timestamp: string; // ISO datetime
	token: {
		id: number;
		contract: { address: string };
		tokenId: string;
		standard: string; // "fa1.2" or "fa2"
		metadata?: { name?: string; symbol?: string; decimals?: string };
	};
	from?: { address: string };
	to?: { address: string };
	amount: string; // in smallest unit
	transactionId?: number;
}
