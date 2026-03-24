// Algorand account tracking and AlgoNode Indexer API response types.

export interface AlgorandAccount {
	id: string;
	address: string; // Base32, 58 chars, uppercase
	label: string;
	next_token: string | null; // Pagination cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface AlgorandSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── AlgoNode Indexer API Response Types ──────────────────────────

export interface AlgorandTransaction {
	id: string; // transaction ID
	"round-time": number; // unix timestamp
	"tx-type": string; // "pay", "axfer", "afrz", "keyreg", "appl", "acfg"
	sender: string;
	fee: number; // microAlgo
	"payment-transaction"?: AlgorandPaymentTx;
	"asset-transfer-transaction"?: AlgorandAssetTransferTx;
	"confirmed-round": number;
}

export interface AlgorandPaymentTx {
	receiver: string;
	amount: number; // microAlgo
	"close-remainder-to"?: string;
	"close-amount"?: number;
}

export interface AlgorandAssetTransferTx {
	receiver: string;
	amount: number;
	"asset-id": number;
	"close-to"?: string;
	"close-amount"?: number;
}

export interface AlgorandTransactionListResponse {
	transactions: AlgorandTransaction[];
	"next-token"?: string;
}
