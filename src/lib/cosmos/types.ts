// Cosmos account tracking and API response types.

export interface CosmosAccount {
	id: string;
	address: string; // cosmos1... bech32
	label: string;
	last_offset: number | null; // pagination offset cursor
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface CosmosSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── LCD API Response Types ──────────────────────────

export interface CosmosTxResponse {
	txhash: string;
	height: string;
	code: number; // 0 = success
	timestamp: string; // ISO datetime
	tx: {
		body: {
			messages: CosmosMessage[];
			memo: string;
		};
		auth_info: {
			fee: { amount: Array<{ denom: string; amount: string }>; gas_limit: string };
		};
	};
	gas_wanted: string;
	gas_used: string;
}

export type CosmosMessage =
	| { "@type": "/cosmos.bank.v1beta1.MsgSend"; from_address: string; to_address: string; amount: Array<{ denom: string; amount: string }> }
	| { "@type": "/cosmos.staking.v1beta1.MsgDelegate"; delegator_address: string; validator_address: string; amount: { denom: string; amount: string } }
	| { "@type": "/cosmos.staking.v1beta1.MsgUndelegate"; delegator_address: string; validator_address: string; amount: { denom: string; amount: string } }
	| { "@type": "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward"; delegator_address: string; validator_address: string }
	| { "@type": "/ibc.applications.transfer.v1.MsgTransfer"; sender: string; receiver: string; token: { denom: string; amount: string }; source_channel: string }
	| { "@type": string; [key: string]: unknown };
