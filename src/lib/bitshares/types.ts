// Bitshares blockchain types for account tracking and sync

export interface BitsharesAccount {
  id: string;
  address: string;            // account name (e.g., "alice")
  account_object_id: string;  // resolved Graphene object ID (e.g., "1.2.849826")
  label: string;
  last_operation_id: string | null;  // pagination cursor (e.g., "1.11.108975045")
  last_sync: string | null;
  created_at: string;
}

export interface BitsharesSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

// ── Graphene amount type ──

export interface BitsharesAmount {
  amount: number;   // integer, divide by 10^precision
  asset_id: string; // e.g., "1.3.0" for BTS
}

// ── Resolved asset metadata ──

export interface BitsharesAssetInfo {
  id: string;       // "1.3.x"
  symbol: string;   // "BTS", "USD", "CNY", etc.
  precision: number; // decimal places
}

// ── Operation envelope ──

export interface BitsharesOperationEntry {
  id: string;        // operation history ID, e.g., "1.11.108975045"
  op: [number, Record<string, unknown>]; // [op_type_id, op_data]
  result: unknown;
  block_num: number;
  trx_in_block: number;
  op_in_trx: number;
  virtual_op: number;
}

// ── Operation-specific data interfaces ──

/** Op 0: transfer */
export interface TransferOp {
  fee: BitsharesAmount;
  from: string;       // "1.2.x"
  to: string;         // "1.2.x"
  amount: BitsharesAmount;
  memo?: { from: string; to: string; nonce: string; message: string };
}

/** Op 1: limit_order_create */
export interface LimitOrderCreateOp {
  fee: BitsharesAmount;
  seller: string;         // "1.2.x"
  amount_to_sell: BitsharesAmount;
  min_to_receive: BitsharesAmount;
  expiration: string;
  fill_or_kill: boolean;
}

/** Op 2: limit_order_cancel */
export interface LimitOrderCancelOp {
  fee: BitsharesAmount;
  fee_paying_account: string; // "1.2.x"
  order: string;              // "1.7.x" limit order object ID
}

/** Op 3: call_order_update (SmartCoin collateral) */
export interface CallOrderUpdateOp {
  fee: BitsharesAmount;
  funding_account: string; // "1.2.x"
  delta_collateral: BitsharesAmount;
  delta_debt: BitsharesAmount;
}

/** Op 4: fill_order (virtual — DEX trade execution) */
export interface FillOrderOp {
  fee: BitsharesAmount;
  order_id: string;   // "1.7.x" or "1.8.x"
  account_id: string; // "1.2.x"
  pays: BitsharesAmount;
  receives: BitsharesAmount;
  is_maker: boolean;
}

/** Op 17: asset_settle */
export interface AssetSettleOp {
  fee: BitsharesAmount;
  account: string; // "1.2.x"
  amount: BitsharesAmount;
}

/** Op 33: vesting_balance_withdraw */
export interface VestingBalanceWithdrawOp {
  fee: BitsharesAmount;
  vesting_balance: string; // "1.13.x"
  owner: string;           // "1.2.x"
  amount: BitsharesAmount;
}

/** Op 61: liquidity_pool_deposit */
export interface LiquidityPoolDepositOp {
  fee: BitsharesAmount;
  account: string; // "1.2.x"
  pool: string;    // "1.19.x"
  amount_a: BitsharesAmount;
  amount_b: BitsharesAmount;
}

/** Op 62: liquidity_pool_withdraw */
export interface LiquidityPoolWithdrawOp {
  fee: BitsharesAmount;
  account: string;       // "1.2.x"
  pool: string;          // "1.19.x"
  share_amount: BitsharesAmount;
}

/** Op 63: liquidity_pool_exchange */
export interface LiquidityPoolExchangeOp {
  fee: BitsharesAmount;
  account: string;         // "1.2.x"
  pool: string;            // "1.19.x"
  amount_to_sell: BitsharesAmount;
  min_to_receive: BitsharesAmount;
}
