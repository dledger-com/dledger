// BTC-fork chain types — shared module for DOGE, LTC, and BCH.

export type BtcForkChain = "doge" | "ltc" | "bch";

export interface BtcForkChainConfig {
	id: BtcForkChain;
	name: string;           // "Dogecoin", "Litecoin", "Bitcoin Cash"
	symbol: string;         // "DOGE", "LTC", "BCH"
	coinType: number;       // BIP-44 coin type
	decimals: number;       // 8 for all three
	addressRegex: RegExp;   // validation pattern
	apiBaseUrl: string;
	apiProxyPrefix: string;
	apiStyle: "mempool" | "blockcypher" | "blockchair";
}

export interface BtcForkAccount {
	id: string;
	chain: BtcForkChain;
	address: string;
	label: string;
	last_sync: string | null;
	created_at: string;
}

export interface BtcForkSyncResult {
	transactions_imported: number;
	transactions_skipped: number;
	accounts_created: number;
	warnings: string[];
}

/** Normalized transaction shape across all three API styles. */
export interface NormalizedTx {
	txid: string;
	timestamp: number;      // unix seconds
	inputs: { address: string; value: number }[];   // satoshis
	outputs: { address: string; value: number }[];   // satoshis
	fee: number;            // satoshis
}

export interface BtcForkInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

export interface DerivedBtcForkAddress {
	index: number;
	address: string;
}

// ── Chain Configurations ─────────────────────────────────

export const BTC_FORK_CHAINS: Record<BtcForkChain, BtcForkChainConfig> = {
	doge: {
		id: "doge",
		name: "Dogecoin",
		symbol: "DOGE",
		coinType: 3,
		decimals: 8,
		addressRegex: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/,
		apiBaseUrl: "https://api.blockcypher.com",
		apiProxyPrefix: "/api/doge",
		apiStyle: "blockcypher",
	},
	ltc: {
		id: "ltc",
		name: "Litecoin",
		symbol: "LTC",
		coinType: 2,
		decimals: 8,
		addressRegex: /^(L[a-km-zA-HJ-NP-Z1-9]{26,33}|M[a-km-zA-HJ-NP-Z1-9]{26,33}|ltc1[a-z0-9]{39,59})$/,
		apiBaseUrl: "https://litecoinspace.org",
		apiProxyPrefix: "/api/ltc",
		apiStyle: "mempool",
	},
	bch: {
		id: "bch",
		name: "Bitcoin Cash",
		symbol: "BCH",
		coinType: 145,
		decimals: 8,
		addressRegex: /^(bitcoincash:)?[qp][a-z0-9]{41}$/,
		apiBaseUrl: "https://api.blockchair.com",
		apiProxyPrefix: "/api/bch",
		apiStyle: "blockchair",
	},
};
