// XRP Ledger account tracking and API response types.

export interface XrpAccount {
	id: string;
	address: string; // r-address (Base58Check, starts with 'r')
	label: string;
	last_marker: string | null; // pagination marker for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface XrpSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── XRPL JSON-RPC Response Types ─────────────────────────

export interface XrpTransaction {
	hash: string;
	date: number; // seconds since Ripple epoch (2000-01-01)
	TransactionType: string; // "Payment", "TrustSet", "OfferCreate", etc.
	Account: string; // sender address
	Destination?: string; // receiver address (Payment only)
	Amount?: string | XrpIssuedAmount; // drops (string) or issued currency object
	Fee: string; // drops
	meta: {
		TransactionResult: string; // "tesSUCCESS" etc.
		delivered_amount?: string | XrpIssuedAmount;
	};
}

export interface XrpIssuedAmount {
	currency: string;
	issuer: string;
	value: string;
}

export interface XrpAccountTxResponse {
	result: {
		account: string;
		transactions: Array<{
			tx: XrpTransaction;
			validated: boolean;
		}>;
		marker?: string;
		status: string;
	};
}

export interface XrpInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}
