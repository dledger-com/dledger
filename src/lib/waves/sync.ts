// Waves sync — fetch transactions via the node REST API and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend, GenericBlockchainAccount } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import {
  renderDescription,
  onchainTransferDescription,
  tradeDescription,
  defiActionDescription,
} from "../types/description-data.js";
import {
  walletAssets,
  walletExternal,
  chainFees,
  tradingAccount,
} from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { ensureCurrencyExists } from "../currency-type.js";
import { deriveAndRecordTradeRate, type TradeRateItem } from "../utils/derive-trade-rate.js";
import { WavesClient } from "./api.js";
import type {
  WavesAssetDetails,
  WavesExchangeTx,
  WavesInvokeScriptTx,
  WavesLeaseCancelTx,
  WavesLeaseTx,
  WavesMassTransferTx,
  WavesOrder,
  WavesStateTransfer,
  WavesSyncResult,
  WavesTransaction,
  WavesTransferTx,
  WavesEthereumTx,
} from "./types.js";

const CHAIN = "Waves";
const SOURCE_PREFIX = "waves";
const WAVES_DECIMALS = 8;

interface LineItemData {
  account: string;
  currency: string;
  amount: string;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

function dateFromTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function toDecimal(amount: number | string, decimals: number): Decimal {
  return new Decimal(amount).dividedBy(new Decimal(10).pow(decimals));
}

function isSuccessful(tx: WavesTransaction): boolean {
  return tx.applicationStatus === undefined || tx.applicationStatus === "succeeded";
}

export async function syncWavesAccount(
  backend: Backend,
  account: GenericBlockchainAccount,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  client: WavesClient = new WavesClient(),
): Promise<WavesSyncResult> {
  const result: WavesSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const addr = account.address;
  const label = account.label;

  // ── Fetch ─────────────────────────────────────────────
  onProgress?.("Fetching Waves transactions...");
  const txs = await client.fetchNewTransactions(
    addr,
    account.cursor ?? null,
    signal,
    (n) => onProgress?.(`Fetched ${n} transactions...`),
  );

  if (txs.length === 0) {
    onProgress?.("No new transactions.");
    return result;
  }

  onProgress?.(`Processing ${txs.length} transactions...`);

  // ── Caches ────────────────────────────────────────────
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);

  const existingSources = new Set<string>();
  for (const [e] of await backend.queryJournalEntries({})) {
    if (e.source.startsWith(`${SOURCE_PREFIX}:`)) existingSources.add(e.source);
  }

  // ── Helpers ───────────────────────────────────────────
  async function resolveAsset(assetId: string | null): Promise<{ code: string; decimals: number }> {
    if (!assetId) return { code: "WAVES", decimals: WAVES_DECIMALS };
    try {
      const details = await client.getAssetDetails(assetId, signal);
      return {
        code: assetCode(details),
        decimals: details.decimals,
      };
    } catch (e) {
      result.warnings.push(`asset details ${assetId.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      return { code: assetId.slice(0, 8), decimals: 0 };
    }
  }

  async function ensureCurrency(code: string, decimals: number): Promise<void> {
    await ensureCurrencyExists(backend, code, currencySet, {
      context: "crypto-chain",
      decimals,
    });
  }

  function inferAccountType(fullName: string): "asset" | "liability" | "equity" | "revenue" | "expense" {
    const first = fullName.split(":")[0];
    switch (first) {
      case "Assets": return "asset";
      case "Liabilities": return "liability";
      case "Equity": return "equity";
      case "Income": return "revenue";
      case "Expenses": return "expense";
      default: return "expense";
    }
  }

  async function ensureAccount(fullName: string, date: string): Promise<string> {
    const existing = accountMap.get(fullName);
    if (existing) return existing.id;
    const parts = fullName.split(":");
    let parentId: string | null = null;
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorName = parts.slice(0, depth).join(":");
      const ancestor = accountMap.get(ancestorName);
      if (ancestor) {
        parentId = ancestor.id;
      } else {
        const id = uuidv7();
        const acc: Account = {
          id,
          parent_id: parentId,
          account_type: inferAccountType(fullName),
          name: parts[depth - 1],
          full_name: ancestorName,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        };
        await backend.createAccount(acc);
        accountMap.set(ancestorName, acc);
        result.accounts_created++;
        parentId = id;
      }
    }
    const id = uuidv7();
    const acc: Account = {
      id,
      parent_id: parentId,
      account_type: inferAccountType(fullName),
      name: parts[parts.length - 1],
      full_name: fullName,
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: date,
    };
    await backend.createAccount(acc);
    accountMap.set(fullName, acc);
    result.accounts_created++;
    return id;
  }

  function walletAccount(): string {
    return walletAssets(CHAIN, label);
  }

  async function postEntry(
    source: string,
    date: string,
    items: LineItemData[],
    description: string,
    descriptionData: import("../types/description-data.js").DescriptionData,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      return false;
    }
    if (items.length === 0) {
      result.transactions_skipped++;
      return false;
    }

    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      description_data: JSON.stringify(descriptionData),
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    const lineItems: LineItem[] = [];
    for (const item of items) {
      const accountId = await ensureAccount(item.account, date);
      lineItems.push({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: accountId,
        currency: item.currency,
        amount: item.amount,
        lot_id: null,
      });
    }

    try {
      await backend.postJournalEntry(entry, lineItems);
      if (Object.keys(metadata).length > 0) {
        await backend.setMetadata(entryId, metadata);
      }
      existingSources.add(source);
      result.transactions_imported++;
      return true;
    } catch (e) {
      result.warnings.push(`post ${source}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Append a fee line pair (wallet credit + ChainFees debit) to an items list. */
  async function addFee(
    items: LineItemData[],
    tx: { fee: number; feeAssetId: string | null },
  ): Promise<void> {
    if (!tx.fee || tx.fee <= 0) return;
    const { code, decimals } = await resolveAsset(tx.feeAssetId);
    await ensureCurrency(code, decimals);
    const feeAmount = toDecimal(tx.fee, decimals);
    if (feeAmount.isZero()) return;
    items.push(
      { account: walletAccount(), currency: code, amount: feeAmount.neg().toFixed() },
      { account: chainFees(CHAIN), currency: code, amount: feeAmount.toFixed() },
    );
  }

  // ── Transaction handlers ──────────────────────────────

  async function handleTransfer(tx: WavesTransferTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    const { code, decimals } = await resolveAsset(tx.assetId);
    await ensureCurrency(code, decimals);
    const amount = toDecimal(tx.amount, decimals);

    const isSender = tx.sender === addr;
    const isSelf = isSender && tx.recipient === addr;
    const direction: "sent" | "received" | "self" = isSelf ? "self" : isSender ? "sent" : "received";
    const counterparty = isSender ? tx.recipient : tx.sender;

    const items: LineItemData[] = [];
    if (!isSelf) {
      if (isSender) {
        items.push(
          { account: walletAccount(), currency: code, amount: amount.neg().toFixed() },
          { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: code, amount: amount.toFixed() },
        );
      } else {
        items.push(
          { account: walletAccount(), currency: code, amount: amount.toFixed() },
          { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: code, amount: amount.neg().toFixed() },
        );
      }
    }

    if (isSender) await addFee(items, tx);

    const descData = onchainTransferDescription(CHAIN, code, direction, {
      counterparty: shortAddr(counterparty),
      txHash: tx.id,
    });

    await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "transfer",
      "waves:tx_id": tx.id,
      "waves:from": tx.sender,
      "waves:to": tx.recipient,
      "waves:asset": code,
      "waves:amount": amount.toFixed(),
    });
  }

  async function handleMassTransfer(tx: WavesMassTransferTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    const { code, decimals } = await resolveAsset(tx.assetId);
    await ensureCurrency(code, decimals);

    const isSender = tx.sender === addr;
    const items: LineItemData[] = [];
    let direction: "sent" | "received" | "self" = "received";

    if (isSender) {
      direction = "sent";
      let outgoing = new Decimal(0);
      for (const t of tx.transfers) {
        if (t.recipient === addr) continue; // self-entry cancels out — skip
        const amt = toDecimal(t.amount, decimals);
        outgoing = outgoing.plus(amt);
        items.push({
          account: walletExternal(CHAIN, accountPathAddr(t.recipient)),
          currency: code,
          amount: amt.toFixed(),
        });
      }
      if (!outgoing.isZero()) {
        items.unshift({ account: walletAccount(), currency: code, amount: outgoing.neg().toFixed() });
      }
      await addFee(items, tx);
    } else {
      // Incoming: sum entries addressed to this wallet.
      let incoming = new Decimal(0);
      for (const t of tx.transfers) {
        if (t.recipient === addr) incoming = incoming.plus(toDecimal(t.amount, decimals));
      }
      if (incoming.isZero()) { result.transactions_skipped++; return; }
      items.push(
        { account: walletAccount(), currency: code, amount: incoming.toFixed() },
        { account: walletExternal(CHAIN, accountPathAddr(tx.sender)), currency: code, amount: incoming.neg().toFixed() },
      );
    }

    const descData = onchainTransferDescription(CHAIN, code, direction, {
      counterparty: isSender ? `${tx.transfers.length} recipients` : shortAddr(tx.sender),
      txHash: tx.id,
      tokenCount: tx.transfers.length,
    });

    await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "mass-transfer",
      "waves:tx_id": tx.id,
      "waves:asset": code,
      "waves:recipient_count": String(tx.transfers.length),
    });
  }

  async function handleExchange(tx: WavesExchangeTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }

    // Determine which side this wallet is on.
    const userOrder: WavesOrder | null =
      tx.order1.sender === addr ? tx.order1 :
      tx.order2.sender === addr ? tx.order2 :
      null;
    if (!userOrder) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    const amountAsset = userOrder.assetPair.amountAsset;
    const priceAsset = userOrder.assetPair.priceAsset;
    const [amt, price] = await Promise.all([
      resolveAsset(amountAsset),
      resolveAsset(priceAsset),
    ]);
    await ensureCurrency(amt.code, amt.decimals);
    await ensureCurrency(price.code, price.decimals);

    const amountFilled = toDecimal(tx.amount, amt.decimals);
    // Waves price normalization: price is scaled to 10^(8 + priceDecimals - amountDecimals)
    const priceFactor = new Decimal(10).pow(8 + price.decimals - amt.decimals);
    const quoteAmount = new Decimal(tx.price).dividedBy(priceFactor).times(amountFilled);

    const isBuy = userOrder.orderType === "buy";
    const spent = isBuy
      ? { code: price.code, amount: quoteAmount }
      : { code: amt.code, amount: amountFilled };
    const received = isBuy
      ? { code: amt.code, amount: amountFilled }
      : { code: price.code, amount: quoteAmount };

    const items: LineItemData[] = [
      { account: walletAccount(), currency: received.code, amount: received.amount.toFixed() },
      { account: tradingAccount(received.code), currency: received.code, amount: received.amount.neg().toFixed() },
      { account: walletAccount(), currency: spent.code, amount: spent.amount.neg().toFixed() },
      { account: tradingAccount(spent.code), currency: spent.code, amount: spent.amount.toFixed() },
    ];

    // Matcher fee paid by this order only.
    const matcherFee = isBuy ? tx.buyMatcherFee : tx.sellMatcherFee;
    if (matcherFee > 0) {
      const feeAsset = userOrder.matcherFeeAssetId ?? null;
      const feeRes = await resolveAsset(feeAsset);
      await ensureCurrency(feeRes.code, feeRes.decimals);
      const feeAmt = toDecimal(matcherFee, feeRes.decimals);
      if (!feeAmt.isZero()) {
        items.push(
          { account: walletAccount(), currency: feeRes.code, amount: feeAmt.neg().toFixed() },
          { account: chainFees(CHAIN), currency: feeRes.code, amount: feeAmt.toFixed() },
        );
      }
    }

    const descData = tradeDescription(
      CHAIN,
      `${spent.amount.toFixed()} ${spent.code}`,
      `${received.amount.toFixed()} ${received.code}`,
    );

    const posted = await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "exchange",
      "waves:tx_id": tx.id,
      "waves:side": isBuy ? "buy" : "sell",
      "waves:amount": amountFilled.toFixed(),
      "waves:price": new Decimal(tx.price).dividedBy(priceFactor).toFixed(),
      "waves:amount_asset": amt.code,
      "waves:price_asset": price.code,
    });

    if (posted) {
      const rateItems: TradeRateItem[] = items.map((i) => ({
        account_name: i.account,
        currency: i.currency,
        amount: i.amount,
      }));
      try {
        await deriveAndRecordTradeRate(backend, date, rateItems);
      } catch (e) {
        result.warnings.push(`trade rate ${tx.id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async function handleLease(tx: WavesLeaseTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    const amount = toDecimal(tx.amount, WAVES_DECIMALS);
    await ensureCurrency("WAVES", WAVES_DECIMALS);

    const isSender = tx.sender === addr;
    const items: LineItemData[] = [];

    if (isSender) {
      // Move WAVES from available wallet → Leased sub-account.
      items.push(
        { account: walletAccount(), currency: "WAVES", amount: amount.neg().toFixed() },
        { account: `${walletAccount()}:Leased`, currency: "WAVES", amount: amount.toFixed() },
      );
      await addFee(items, tx);
    } else if (tx.recipient === addr) {
      // Pure accounting note: leased funds do not move into our balance.
      result.transactions_skipped++;
      return;
    } else {
      result.transactions_skipped++;
      return;
    }

    const descData = defiActionDescription("Lease", "Start", CHAIN, tx.id, `Lease ${amount.toFixed()} WAVES`);
    await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "lease",
      "waves:tx_id": tx.id,
      "waves:amount": amount.toFixed(),
      "waves:recipient": tx.recipient,
    });
  }

  async function handleLeaseCancel(tx: WavesLeaseCancelTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }
    if (tx.sender !== addr) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    await ensureCurrency("WAVES", WAVES_DECIMALS);
    const items: LineItemData[] = [];
    const leasedAmount = tx.lease?.amount ? toDecimal(tx.lease.amount, WAVES_DECIMALS) : null;

    if (leasedAmount && !leasedAmount.isZero()) {
      items.push(
        { account: `${walletAccount()}:Leased`, currency: "WAVES", amount: leasedAmount.neg().toFixed() },
        { account: walletAccount(), currency: "WAVES", amount: leasedAmount.toFixed() },
      );
    }
    await addFee(items, tx);

    const descData = defiActionDescription("Lease", "Cancel", CHAIN, tx.id, "Lease cancel");
    await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "lease-cancel",
      "waves:tx_id": tx.id,
      "waves:lease_id": tx.leaseId,
    });
  }

  async function handleInvokeScript(tx: WavesInvokeScriptTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    const source = `${SOURCE_PREFIX}:${tx.id}`;
    if (existingSources.has(source)) { result.transactions_skipped++; return; }

    const date = dateFromTimestamp(tx.timestamp);
    const isSender = tx.sender === addr;
    const items: LineItemData[] = [];

    // Aggregate per currency: payments out (when sender) + stateChanges transfers to/from address.
    const net = new Map<string, Decimal>();
    const assetDecimals = new Map<string, number>();

    async function addFlow(assetId: string | null, delta: Decimal): Promise<string> {
      const { code, decimals } = await resolveAsset(assetId);
      await ensureCurrency(code, decimals);
      assetDecimals.set(code, decimals);
      const prev = net.get(code) ?? new Decimal(0);
      net.set(code, prev.plus(delta));
      return code;
    }

    if (isSender && tx.payment) {
      for (const p of tx.payment) {
        const amt = await resolveAsset(p.assetId);
        await addFlow(p.assetId, toDecimal(p.amount, amt.decimals).neg());
      }
    }

    const transfers: WavesStateTransfer[] = tx.stateChanges?.transfers ?? [];
    for (const t of transfers) {
      if (t.address !== addr) continue;
      const info = await resolveAsset(t.asset);
      await addFlow(t.asset, toDecimal(t.amount, info.decimals));
    }

    // Build line items from net flows: wallet adjustment + DeFi counterpart.
    for (const [code, delta] of net) {
      if (delta.isZero()) continue;
      items.push({ account: walletAccount(), currency: code, amount: delta.toFixed() });
      items.push({
        account: `Assets:Crypto:DeFi:Waves:${accountPathAddr(tx.dApp)}:${code}`,
        currency: code,
        amount: delta.neg().toFixed(),
      });
    }

    if (isSender) await addFee(items, tx);

    if (items.length === 0) {
      result.transactions_skipped++;
      return;
    }

    const descData = defiActionDescription(
      `dApp ${shortAddr(tx.dApp)}`,
      tx.call?.function ?? "invoke",
      CHAIN,
      tx.id,
    );

    await postEntry(source, date, items, renderDescription(descData), descData, {
      "waves:tx_type": "invoke-script",
      "waves:tx_id": tx.id,
      "waves:dapp": tx.dApp,
      "waves:function": tx.call?.function ?? "",
    });
  }

  async function handleEthereum(tx: WavesEthereumTx): Promise<void> {
    if (!isSuccessful(tx)) { result.transactions_skipped++; return; }
    if (tx.payload.type !== "transfer") {
      result.warnings.push(`Skipped Ethereum invocation tx ${tx.id.slice(0, 12)} (not yet supported).`);
      result.transactions_skipped++;
      return;
    }
    // Reuse Transfer handler by shaping a fake WavesTransferTx.
    const t: WavesTransferTx = {
      id: tx.id,
      type: 4,
      version: tx.version,
      sender: tx.sender,
      senderPublicKey: tx.senderPublicKey,
      fee: tx.fee,
      feeAssetId: tx.feeAssetId,
      timestamp: tx.timestamp,
      height: tx.height,
      applicationStatus: tx.applicationStatus,
      chainId: tx.chainId,
      recipient: tx.payload.recipient,
      amount: tx.payload.amount,
      assetId: tx.payload.asset,
    };
    await handleTransfer(t);
  }

  // ── Main loop ─────────────────────────────────────────
  let newCursorId: string | null = txs[0]?.id ?? null;

  // Process oldest-first so the cursor (newest seen) is set last.
  for (let i = txs.length - 1; i >= 0; i--) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const tx = txs[i];
    onProgress?.(`Processing ${txs.length - i}/${txs.length}...`);

    try {
      await backend.storeRawTransaction(`${SOURCE_PREFIX}:${tx.id}`, JSON.stringify(tx));
    } catch { /* may exist */ }

    try {
      switch (tx.type) {
        case 4:  await handleTransfer(tx as WavesTransferTx); break;
        case 7:  await handleExchange(tx as WavesExchangeTx); break;
        case 8:  await handleLease(tx as WavesLeaseTx); break;
        case 9:  await handleLeaseCancel(tx as WavesLeaseCancelTx); break;
        case 11: await handleMassTransfer(tx as WavesMassTransferTx); break;
        case 16: await handleInvokeScript(tx as WavesInvokeScriptTx); break;
        case 18: await handleEthereum(tx as WavesEthereumTx); break;
        default:
          result.warnings.push(`Skipped Waves tx type ${tx.type} (${tx.id.slice(0, 12)})`);
          result.transactions_skipped++;
      }
    } catch (e) {
      result.warnings.push(`process ${tx.id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      result.transactions_skipped++;
    }
  }

  if (newCursorId) {
    await backend.updateBlockchainAccountCursor(account.id, newCursorId);
  }

  onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
  if (result.transactions_imported > 0) {
    invalidate("journal", "accounts", "reports");
  }
  return result;
}

function assetCode(details: WavesAssetDetails): string {
  const ticker = (details.ticker ?? "").trim();
  if (ticker && /^[A-Za-z0-9._\-/]+$/.test(ticker)) return ticker.toUpperCase();
  const name = (details.name ?? "").trim();
  if (name && /^[A-Za-z0-9._\-/]+$/.test(name)) return name.toUpperCase();
  return details.assetId.slice(0, 8);
}
