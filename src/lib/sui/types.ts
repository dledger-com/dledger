// Sui account tracking and API response types.

export interface SuiAccount {
	id: string;
	address: string; // 0x + 64 hex chars
	label: string;
	last_cursor: string | null; // GraphQL cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface SuiSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── GraphQL API Response Types ──────────────────────────

export interface SuiTransactionNode {
	digest: string;
	effects: {
		timestamp: string | null; // ISO datetime
		status: string; // "SUCCESS" | "FAILURE"
		balanceChanges: {
			nodes: SuiBalanceChange[];
		};
		gasEffects: {
			gasSummary: {
				computationCost: string;
				storageCost: string;
				storageRebate: string;
			};
		};
	};
}

export interface SuiBalanceChange {
	owner: { asAddress: { address: string } | null } | null;
	coinType: { repr: string }; // e.g., "0x2::sui::SUI"
	amount: string; // signed: positive = received, negative = sent
}

export interface SuiPageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}
