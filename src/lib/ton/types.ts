// TON account tracking and API response types.

export interface TonAccount {
	id: string;
	address: string; // User-friendly Base64 format (EQ... or UQ...)
	label: string;
	last_lt: string | null; // Logical time cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface TonSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── TonAPI Response Types ──────────────────────────

export interface TonEvent {
	event_id: string;
	timestamp: number;
	actions: TonAction[];
	lt: number;
	is_scam: boolean;
	fee: { account: string; total: number };
}

export interface TonAction {
	type: string; // "TonTransfer", "JettonTransfer", "NftItemTransfer", "ContractDeploy", etc.
	status: string; // "ok", "failed"
	TonTransfer?: { sender: TonAddress; recipient: TonAddress; amount: number; comment?: string };
	JettonTransfer?: { sender: TonAddress; recipient: TonAddress; amount: string; jetton: TonJetton; comment?: string };
}

export interface TonAddress {
	address: string;
	name?: string;
	is_scam?: boolean;
}

export interface TonJetton {
	address: string;
	name: string;
	symbol: string;
	decimals: number;
	image?: string;
}
