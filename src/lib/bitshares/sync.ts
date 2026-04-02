// Bitshares account sync — fetches operations and creates journal entries.

import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import {
  renderDescription,
  onchainTransferDescription,
  tradeDescription,
  defiActionDescription,
  rewardDescription,
  operationDescription,
  type DescriptionData,
} from "../types/description-data.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import {
  walletAssets,
  walletExternal,
  chainFees,
  tradingAccount,
  defiAssets,
  defiLiabilities,
  exchangeStaking,
} from "../accounts/paths.js";
import { BitsharesClient } from "./api.js";
import type {
  BitsharesAccount,
  BitsharesSyncResult,
  BitsharesAmount,
  BitsharesAssetInfo,
  BitsharesOperationEntry,
  TransferOp,
  FillOrderOp,
  LimitOrderCreateOp,
  CallOrderUpdateOp,
  AssetSettleOp,
  VestingBalanceWithdrawOp,
  LiquidityPoolDepositOp,
  LiquidityPoolWithdrawOp,
  LiquidityPoolExchangeOp,
} from "./types.js";

const CHAIN = "Bitshares";
const SOURCE_PREFIX = "bitshares";

function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function accountPathAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}-${addr.slice(-4)}`;
}

/** Convert a Graphene integer amount to a decimal string using asset precision. */
function toDecimal(amount: BitsharesAmount, asset: BitsharesAssetInfo): string {
  return new Decimal(amount.amount).dividedBy(new Decimal(10).pow(asset.precision)).toFixed(asset.precision);
}

/** Extract the numeric suffix from a Graphene object ID for ordering comparison. */
function objectIdNum(objectId: string): number {
  const parts = objectId.split(".");
  return parseInt(parts[2] ?? "0", 10);
}

/** Intermediate line item before we assign IDs. */
interface LineItemData {
  account: string;  // full account path
  currency: string;
  amount: string;
}

export async function syncBitsharesAccount(
  backend: Backend,
  account: BitsharesAccount,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BitsharesSyncResult> {
  const result: BitsharesSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const client = new BitsharesClient();
  try {
    onProgress?.("Connecting to Bitshares node...");
    await client.connect();

    // Resolve account name to object ID if not already stored
    let accountObjectId = account.account_object_id;
    if (!accountObjectId) {
      onProgress?.(`Resolving account "${account.address}"...`);
      const resolved = await client.getAccountByName(account.address);
      if (!resolved) {
        result.warnings.push(`Account "${account.address}" not found on Bitshares network`);
        return result;
      }
      accountObjectId = resolved.id;
      await backend.updateBitsharesAccountObjectId(account.id, accountObjectId);
    }

    // Build caches
    const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
    const accountMap = new Map<string, Account>();
    for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
    const existingSources = new Set<string>();
    for (const [e] of await backend.queryJournalEntries({})) {
      if (e.source.startsWith(`${SOURCE_PREFIX}:`)) existingSources.add(e.source);
    }

    async function ensureCurrency(symbol: string, precision: number): Promise<void> {
      if (currencySet.has(symbol)) return;
      const assetType = FIAT_CURRENCIES.has(symbol) ? "fiat" : "crypto";
      await backend.createCurrency({
        code: symbol, asset_type: assetType, param: "",
        name: symbol, decimal_places: precision, is_base: false,
      });
      currencySet.add(symbol);
    }

    async function ensureAccount(fullName: string, date: string): Promise<string> {
      const existing = accountMap.get(fullName);
      if (existing) return existing.id;
      const id = uuidv7();
      const parts = fullName.split(":");
      const firstPart = parts[0];
      let accountType: Account["account_type"] = "asset";
      if (firstPart === "Expenses") accountType = "expense";
      else if (firstPart === "Income") accountType = "revenue";
      else if (firstPart === "Equity") accountType = "equity";
      else if (firstPart === "Liabilities") accountType = "liability";

      const acc: Account = {
        id, parent_id: null, account_type: accountType,
        name: parts[parts.length - 1], full_name: fullName,
        allowed_currencies: [], is_postable: true, is_archived: false, created_at: date,
      };
      await backend.createAccount(acc);
      accountMap.set(fullName, acc);
      result.accounts_created++;
      return id;
    }

    /** Resolve a BitsharesAmount to symbol, decimal string, and precision. */
    async function resolveAmount(amt: BitsharesAmount): Promise<{ symbol: string; amount: string; precision: number }> {
      const asset = await client.getAsset(amt.asset_id);
      if (!asset) throw new Error(`Unknown Bitshares asset: ${amt.asset_id}`);
      await ensureCurrency(asset.symbol, asset.precision);
      return { symbol: asset.symbol, amount: toDecimal(amt, asset), precision: asset.precision };
    }

    // Paginate through operation history
    let cursor = "1.11.0"; // start from latest
    const stopAt = account.last_operation_id;
    let newestOpId: string | null = null;
    let totalFetched = 0;

    while (true) {
      if (signal?.aborted) break;

      const ops = await client.getAccountHistory(accountObjectId, "1.11.0", 100, cursor);
      if (ops.length === 0) break;

      for (const op of ops) {
        if (signal?.aborted) break;

        // Stop if we've reached the last synced operation
        if (stopAt && op.id === stopAt) {
          cursor = ""; // signal end
          break;
        }

        // Track newest operation for cursor update
        if (!newestOpId || objectIdNum(op.id) > objectIdNum(newestOpId)) {
          newestOpId = op.id;
        }

        const source = `${SOURCE_PREFIX}:${op.id}`;
        if (existingSources.has(source)) {
          result.transactions_skipped++;
          continue;
        }

        try {
          const processed = await processOperation(op, accountObjectId, account.label, client, resolveAmount);
          if (!processed) {
            result.transactions_skipped++;
            continue;
          }

          // Get block timestamp for date
          const header = await client.getBlockHeader(op.block_num);
          const date = header?.timestamp ? header.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);

          // Resolve account paths to IDs and build full LineItem objects
          const entryId = uuidv7();
          const lineItems: LineItem[] = [];
          for (const item of processed.lineItems) {
            const accountId = await ensureAccount(item.account, date);
            lineItems.push({
              id: uuidv7(), journal_entry_id: entryId,
              account_id: accountId, currency: item.currency,
              amount: item.amount, lot_id: null,
            });
          }

          const description = renderDescription(processed.descData);
          const entry: JournalEntry = {
            id: entryId, date, description,
            description_data: JSON.stringify(processed.descData),
            status: "confirmed", source, voided_by: null, created_at: date,
          };

          await backend.storeRawTransaction(source, JSON.stringify(op));
          await backend.postJournalEntry(entry, lineItems);
          existingSources.add(source);
          result.transactions_imported++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.warnings.push(`Op ${op.id}: ${msg}`);
        }
      }

      if (!cursor || cursor === "") break;

      // Move cursor to the oldest operation in this batch for next page
      const oldestOp = ops[ops.length - 1];
      if (objectIdNum(oldestOp.id) <= 1) break;
      cursor = `1.11.${objectIdNum(oldestOp.id) - 1}`;

      totalFetched += ops.length;
      onProgress?.(`Processed ${totalFetched} operations...`);
    }

    // Update pagination cursor
    if (newestOpId) {
      await backend.updateBitsharesSyncCursor(account.id, newestOpId);
    }
  } finally {
    client.disconnect();
  }

  return result;
}

// ── Operation processor ──

interface ProcessedOp {
  descData: DescriptionData;
  lineItems: LineItemData[];
}

async function processOperation(
  op: BitsharesOperationEntry,
  ourAccountId: string,
  label: string,
  client: BitsharesClient,
  resolveAmount: (amt: BitsharesAmount) => Promise<{ symbol: string; amount: string; precision: number }>,
): Promise<ProcessedOp | null> {
  const opType = op.op[0];
  const opData = op.op[1];
  const items: LineItemData[] = [];
  let descData: DescriptionData;

  const feeData = opData.fee as BitsharesAmount | undefined;
  const txRef = op.id; // e.g. "1.11.108975045"

  switch (opType) {
    case 0: { // transfer
      const data = opData as unknown as TransferOp;
      const amt = await resolveAmount(data.amount);
      const isSend = data.from === ourAccountId;
      const counterparty = isSend ? data.to : data.from;
      const counterpartyShort = shortAddr(counterparty);

      descData = onchainTransferDescription(CHAIN, amt.symbol, isSend ? "sent" : "received", {
        counterparty: counterpartyShort, txHash: txRef,
      });

      const wallet = walletAssets(CHAIN, label);
      const ext = walletExternal(CHAIN, accountPathAddr(counterparty));

      if (isSend) {
        items.push({ account: wallet, currency: amt.symbol, amount: new Decimal(amt.amount).neg().toFixed() });
        items.push({ account: ext, currency: amt.symbol, amount: amt.amount });
      } else {
        items.push({ account: wallet, currency: amt.symbol, amount: amt.amount });
        items.push({ account: ext, currency: amt.symbol, amount: new Decimal(amt.amount).neg().toFixed() });
      }
      break;
    }

    case 1: { // limit_order_create — lock funds into DEX order
      const data = opData as unknown as LimitOrderCreateOp;
      const sell = await resolveAmount(data.amount_to_sell);

      descData = operationDescription(CHAIN, "Limit order create", sell.symbol);

      items.push({ account: walletAssets(CHAIN, label), currency: sell.symbol, amount: new Decimal(sell.amount).neg().toFixed() });
      items.push({ account: tradingAccount(sell.symbol), currency: sell.symbol, amount: sell.amount });
      break;
    }

    case 2: { // limit_order_cancel — return locked funds
      return null;
    }

    case 3: { // call_order_update — SmartCoin collateral
      const data = opData as unknown as CallOrderUpdateOp;
      const collateral = await resolveAmount(data.delta_collateral);
      const debt = await resolveAmount(data.delta_debt);

      descData = defiActionDescription(CHAIN, "Collateral update", CHAIN, txRef);

      const wallet = walletAssets(CHAIN, label);

      if (!new Decimal(collateral.amount).isZero()) {
        items.push({ account: wallet, currency: collateral.symbol, amount: new Decimal(collateral.amount).neg().toFixed() });
        items.push({ account: defiAssets(CHAIN, "Collateral"), currency: collateral.symbol, amount: collateral.amount });
      }
      if (!new Decimal(debt.amount).isZero()) {
        items.push({ account: wallet, currency: debt.symbol, amount: debt.amount });
        items.push({ account: defiLiabilities(CHAIN, "SmartCoin"), currency: debt.symbol, amount: new Decimal(debt.amount).neg().toFixed() });
      }
      break;
    }

    case 4: { // fill_order — DEX trade execution
      const data = opData as unknown as FillOrderOp;
      const pays = await resolveAmount(data.pays);
      const receives = await resolveAmount(data.receives);

      descData = tradeDescription(CHAIN, pays.symbol, receives.symbol);

      const wallet = walletAssets(CHAIN, label);
      items.push({ account: wallet, currency: pays.symbol, amount: new Decimal(pays.amount).neg().toFixed() });
      items.push({ account: wallet, currency: receives.symbol, amount: receives.amount });
      items.push({ account: tradingAccount(pays.symbol), currency: pays.symbol, amount: pays.amount });
      items.push({ account: tradingAccount(receives.symbol), currency: receives.symbol, amount: new Decimal(receives.amount).neg().toFixed() });
      break;
    }

    case 17: { // asset_settle — SmartCoin settlement
      const data = opData as unknown as AssetSettleOp;
      const amt = await resolveAmount(data.amount);

      descData = defiActionDescription(CHAIN, "Settlement", CHAIN, txRef);

      items.push({ account: walletAssets(CHAIN, label), currency: amt.symbol, amount: new Decimal(amt.amount).neg().toFixed() });
      items.push({ account: defiLiabilities(CHAIN, "SmartCoin"), currency: amt.symbol, amount: amt.amount });
      break;
    }

    case 33: { // vesting_balance_withdraw — income
      const data = opData as unknown as VestingBalanceWithdrawOp;
      const amt = await resolveAmount(data.amount);

      descData = rewardDescription(CHAIN, "Vesting withdrawal", amt.symbol);

      items.push({ account: walletAssets(CHAIN, label), currency: amt.symbol, amount: amt.amount });
      items.push({ account: exchangeStaking(CHAIN), currency: amt.symbol, amount: new Decimal(amt.amount).neg().toFixed() });
      break;
    }

    case 61: { // liquidity_pool_deposit
      const data = opData as unknown as LiquidityPoolDepositOp;
      const amtA = await resolveAmount(data.amount_a);
      const amtB = await resolveAmount(data.amount_b);

      descData = defiActionDescription(CHAIN, "LP deposit", CHAIN, txRef);

      const wallet = walletAssets(CHAIN, label);
      const lp = defiAssets(CHAIN, "LP");
      items.push({ account: wallet, currency: amtA.symbol, amount: new Decimal(amtA.amount).neg().toFixed() });
      items.push({ account: lp, currency: amtA.symbol, amount: amtA.amount });
      items.push({ account: wallet, currency: amtB.symbol, amount: new Decimal(amtB.amount).neg().toFixed() });
      items.push({ account: lp, currency: amtB.symbol, amount: amtB.amount });
      break;
    }

    case 62: { // liquidity_pool_withdraw
      const data = opData as unknown as LiquidityPoolWithdrawOp;
      const shares = await resolveAmount(data.share_amount);

      descData = defiActionDescription(CHAIN, "LP withdraw", CHAIN, txRef);

      items.push({ account: defiAssets(CHAIN, "LP"), currency: shares.symbol, amount: new Decimal(shares.amount).neg().toFixed() });
      items.push({ account: walletAssets(CHAIN, label), currency: shares.symbol, amount: shares.amount });
      break;
    }

    case 63: { // liquidity_pool_exchange — AMM swap
      const data = opData as unknown as LiquidityPoolExchangeOp;
      const sell = await resolveAmount(data.amount_to_sell);
      const receive = await resolveAmount(data.min_to_receive);

      descData = tradeDescription(CHAIN, sell.symbol, receive.symbol);

      const wallet = walletAssets(CHAIN, label);
      items.push({ account: wallet, currency: sell.symbol, amount: new Decimal(sell.amount).neg().toFixed() });
      items.push({ account: wallet, currency: receive.symbol, amount: receive.amount });
      items.push({ account: tradingAccount(sell.symbol), currency: sell.symbol, amount: sell.amount });
      items.push({ account: tradingAccount(receive.symbol), currency: receive.symbol, amount: new Decimal(receive.amount).neg().toFixed() });
      break;
    }

    default:
      return null;
  }

  // Add fee line items
  if (feeData && feeData.amount > 0) {
    const fee = await resolveAmount(feeData);
    items.push({ account: walletAssets(CHAIN, label), currency: fee.symbol, amount: new Decimal(fee.amount).neg().toFixed() });
    items.push({ account: chainFees(CHAIN), currency: fee.symbol, amount: fee.amount });
  }

  if (items.length === 0) return null;

  return { descData, lineItems: items };
}
