// Hyperliquid account tracking and API response types.

export interface HyperliquidAccount {
	id: string;
	address: string; // 0x EVM address
	label: string;
	last_sync_time: number | null; // ms timestamp cursor for incremental sync
	last_sync: string | null; // ISO datetime for display
	created_at: string;
}

export interface HyperliquidSyncResult {
	fills_imported: number;
	funding_imported: number;
	ledger_imported: number;
	skipped: number;
	accounts_created: number;
	warnings: string[];
}

// ── API Response Types ──────────────────────────────────

export interface HlFill {
	coin: string; // "BTC" for perps, "@128" or "PURR/USDC" for spot
	px: string; // price
	sz: string; // size (unsigned)
	side: "B" | "A"; // B=buy, A=sell (NOT "S")
	time: number; // ms timestamp
	startPosition: string; // position before fill
	dir: string; // Perp: "Open Long"/"Close Short"/etc. Spot: "Buy"/"Sell"
	closedPnl: string; // realized PnL (0 if opening)
	hash: string; // transaction hash
	oid: number; // order ID
	crossed: boolean; // true = taker
	fee: string; // fee amount
	tid: number; // trade ID
	feeToken: string; // fee currency (usually "USDC")
}

export interface HlFundingDelta {
	coin: string;
	fundingRate: string;
	szi: string; // signed size (positive=long, negative=short)
	type: "funding";
	usdc: string; // negative=paid, positive=received
	hash: string;
	time: number; // ms timestamp
	nSamples?: number;
}

export interface HlLedgerUpdate {
	time: number; // ms timestamp
	hash: string;
	delta: HlLedgerDelta;
}

export type HlLedgerDelta =
	| { type: "deposit"; usdc: string }
	| { type: "withdraw"; usdc: string; nonce: number; fee: string }
	| { type: "internalTransfer"; usdc: string; user: string; destination: string; fee: string }
	| { type: "spotTransfer"; token: string; amount: string; usdcValue?: string; user: string; destination: string; fee: string }
	| { type: "liquidation"; leverageType: string; liquidatedUser: string }
	| { type: "vaultDeposit"; vault: string; usdc: string }
	| { type: "vaultWithdraw"; vault: string; usdc: string }
	| { type: "accountClassTransfer"; usdc: string; toPerp: boolean }
	| { type: "subAccountTransfer"; usdc: string; user: string; destination: string };

// ── Clearinghouse State (positions display) ─────────────

export interface HlClearinghouseState {
	assetPositions: { position: HlPosition; type: string }[];
	crossMarginSummary: HlMarginSummary;
	crossMaintenanceMarginUsed: string;
	withdrawable: string;
}

export interface HlPosition {
	coin: string;
	szi: string; // signed size: positive=long, negative=short
	entryPx: string;
	positionValue: string;
	unrealizedPnl: string;
	liquidationPx: string | null;
	leverage: { type: string; value: number };
	cumFunding: { allTime: string; sinceOpen: string; sinceChange: string };
	returnOnEquity: string;
	maxTradeSzs: [string, string];
}

export interface HlMarginSummary {
	accountValue: string;
	totalNtlPos: string;
	totalRawUsd: string;
	totalMarginUsed: string;
}

// ── Spot State ──────────────────────────────────────────

export interface HlSpotClearinghouseState {
	balances: HlSpotBalance[];
}

export interface HlSpotBalance {
	coin: string;
	hold: string; // amount held in open orders
	total: string; // total balance
	token: number; // token index
	entryNtl: string;
}
