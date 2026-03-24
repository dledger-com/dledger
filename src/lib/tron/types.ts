// TRON account tracking and API response types.

export interface TronAccount {
	id: string;
	address: string; // Base58Check, starts with 'T'
	label: string;
	last_fingerprint: string | null; // pagination cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface TronSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── TronGrid API Response Types ──────────────────────────

export interface TronTransaction {
	txID: string;
	blockNumber: number;
	block_timestamp: number; // milliseconds since Unix epoch
	ret: Array<{ contractRet: string }>; // "SUCCESS", "REVERT", etc.
	raw_data: {
		contract: Array<{
			type: string; // "TransferContract", "TriggerSmartContract", etc.
			parameter: {
				value: TronTransferValue | TronTriggerValue;
				type_url: string;
			};
		}>;
		fee_limit?: number;
		timestamp: number;
	};
}

export interface TronTransferValue {
	amount: number; // SUN for TRX transfers
	owner_address: string; // hex-encoded
	to_address: string; // hex-encoded
}

export interface TronTriggerValue {
	owner_address: string; // hex-encoded
	contract_address: string; // hex-encoded
	data?: string; // ABI-encoded call data
}

export interface TronTransactionListResponse {
	data: TronTransaction[];
	success: boolean;
	meta: {
		at: number;
		fingerprint?: string;
		page_size: number;
	};
}

export interface TronInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}
