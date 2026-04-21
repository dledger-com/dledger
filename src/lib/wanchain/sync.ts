// Wanchain sync — fetch native transfers + WRC-20 events, post journal entries.
// Uses RPC (public nodes) by default; falls back to Tokenview for faster native
// scans when the user has configured a Tokenview API key.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend, GenericBlockchainAccount } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import {
  renderDescription,
  onchainTransferDescription,
  onchainContractDescription,
} from "../types/description-data.js";
import { walletAssets, walletExternal, chainFees } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { ensureCurrencyExists } from "../currency-type.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { WanchainClient } from "./api.js";
import type { WanchainSyncResult, WanchainTxGroup, Wrc20Transfer } from "./types.js";

const CHAIN = "Wanchain";
const SOURCE_PREFIX = "wanchain";
const NATIVE_SYMBOL = "WAN";
const NATIVE_DECIMALS = 18;
/** Bound the initial RPC block walk (Wanchain avg ~5s blocks, 20k blocks ≈ 1 day). */
const RPC_INITIAL_WINDOW = 20000;

interface LineItemData {
  account: string;
  currency: string;
  amount: string;
}

function shortAddr(addr: string): string {
  return addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
  const s = addr.toLowerCase().replace(/^0x/, "");
  return s.length >= 10 ? `0x${s.slice(0, 6)}-${s.slice(-4)}` : `0x${s}`;
}

function toDecimal(raw: string, decimals: number): Decimal {
  return new Decimal(raw).dividedBy(new Decimal(10).pow(decimals));
}

export async function syncWanchainAccount(
  backend: Backend,
  account: GenericBlockchainAccount,
  settings: AppSettings,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  client?: WanchainClient,
): Promise<WanchainSyncResult> {
  const result: WanchainSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const addr = account.address.toLowerCase();
  const label = account.label;
  const wanClient = client ?? new WanchainClient({
    tokenviewApiKey: settings.wanchainTokenviewApiKey,
  });

  // ── Determine block range ─────────────────────────────
  onProgress?.("Resolving latest block...");
  let latest: number;
  try {
    latest = await wanClient.getLatestBlock(signal);
  } catch (e) {
    result.warnings.push(`getLatestBlock: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  const cursorBlock = account.cursor ? parseInt(account.cursor, 10) : 0;
  const fromBlock = cursorBlock > 0
    ? cursorBlock + 1
    : wanClient.mode === "rpc"
      ? Math.max(0, latest - RPC_INITIAL_WINDOW + 1)
      : 0;

  if (fromBlock > latest) {
    onProgress?.("Already up to date.");
    return result;
  }

  // ── Fetch transfers ───────────────────────────────────
  onProgress?.(`Fetching activity blocks ${fromBlock}-${latest}...`);
  let native: WanchainTxGroup[] = [];
  let tokens: Wrc20Transfer[] = [];
  try {
    [native, tokens] = await Promise.all([
      wanClient.getNativeTxs(addr, fromBlock, latest, signal, { maxBlocks: RPC_INITIAL_WINDOW }),
      wanClient.getErc20Transfers(addr, fromBlock, latest, signal),
    ]);
  } catch (e) {
    result.warnings.push(`fetch: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  if (native.length === 0 && tokens.length === 0) {
    onProgress?.("No new activity.");
    await backend.updateBlockchainAccountCursor(account.id, String(latest));
    return result;
  }

  // ── Aggregate per tx hash ─────────────────────────────
  const groups = new Map<string, WanchainTxGroup>();
  for (const g of native) {
    groups.set(g.hash.toLowerCase(), { ...g, tokenTransfers: [] });
  }
  for (const t of tokens) {
    const key = t.txHash.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.tokenTransfers.push(t);
    } else {
      groups.set(key, {
        hash: t.txHash,
        blockNumber: t.blockNumber,
        timestamp: 0,
        from: "",
        to: null,
        value: "0",
        gasUsed: "0",
        gasPrice: "0",
        success: true,
        tokenTransfers: [t],
      });
    }
  }

  // Fill in missing tx metadata (timestamp/gas) for groups seen only via token logs.
  for (const g of groups.values()) {
    if (g.timestamp !== 0) continue;
    try {
      const receipt = await wanClient.getReceipt(g.hash, signal);
      if (receipt) {
        g.gasUsed = BigInt(receipt.gasUsed).toString();
        g.success = receipt.status === "0x1";
      }
      const block = await wanClient.getBlockByNumber(g.blockNumber, signal);
      if (block) {
        g.timestamp = parseInt(block.timestamp, 16);
        const fromTx = block.transactions.find((t) => t.hash.toLowerCase() === g.hash.toLowerCase());
        if (fromTx) {
          g.from = fromTx.from;
          g.to = fromTx.to;
          g.value = BigInt(fromTx.value || "0x0").toString();
          g.gasPrice = BigInt(fromTx.gasPrice || "0x0").toString();
        }
      }
    } catch (e) {
      result.warnings.push(`receipt ${g.hash.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Caches + helpers ──────────────────────────────────
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);

  const existingSources = new Set<string>();
  for (const [e] of await backend.queryJournalEntries({})) {
    if (e.source.startsWith(`${SOURCE_PREFIX}:`)) existingSources.add(e.source);
  }

  async function ensureCurrency(code: string, decimals: number, contractAddress?: string): Promise<void> {
    await ensureCurrencyExists(backend, code, currencySet, {
      context: "crypto-chain",
      decimals,
      chain: contractAddress ? "wanchain" : undefined,
      contractAddress,
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
      if (ancestor) { parentId = ancestor.id; continue; }
      const id = uuidv7();
      const acc: Account = {
        id, parent_id: parentId, account_type: inferAccountType(fullName),
        name: parts[depth - 1], full_name: ancestorName, allowed_currencies: [],
        is_postable: true, is_archived: false, created_at: date,
      };
      await backend.createAccount(acc);
      accountMap.set(ancestorName, acc);
      result.accounts_created++;
      parentId = id;
    }
    const id = uuidv7();
    const acc: Account = {
      id, parent_id: parentId, account_type: inferAccountType(fullName),
      name: parts[parts.length - 1], full_name: fullName, allowed_currencies: [],
      is_postable: true, is_archived: false, created_at: date,
    };
    await backend.createAccount(acc);
    accountMap.set(fullName, acc);
    result.accounts_created++;
    return id;
  }

  const walletAccount = walletAssets(CHAIN, label);

  // ── Process groups ────────────────────────────────────
  const sorted = [...groups.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  let maxBlock = cursorBlock;

  for (let i = 0; i < sorted.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const g = sorted[i];
    onProgress?.(`Processing ${i + 1}/${sorted.length} (block ${g.blockNumber})...`);

    if (g.blockNumber > maxBlock) maxBlock = g.blockNumber;

    const source = `${SOURCE_PREFIX}:${g.hash.toLowerCase()}`;
    if (existingSources.has(source)) { result.transactions_skipped++; continue; }
    if (!g.success) { result.transactions_skipped++; continue; }

    try { await backend.storeRawTransaction(source, JSON.stringify(g)); } catch { /* may exist */ }

    const date = g.timestamp > 0 ? new Date(g.timestamp * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const items: LineItemData[] = [];

    const isSender = g.from?.toLowerCase() === addr;
    const isReceiver = g.to?.toLowerCase() === addr;
    const valueWei = g.value ?? "0";

    // Native transfer line items.
    if (valueWei !== "0" && (isSender || isReceiver)) {
      await ensureCurrency(NATIVE_SYMBOL, NATIVE_DECIMALS);
      const amount = toDecimal(valueWei, NATIVE_DECIMALS);
      if (!amount.isZero()) {
        const counterparty = isSender ? g.to ?? "" : g.from;
        if (isSender) {
          items.push(
            { account: walletAccount, currency: NATIVE_SYMBOL, amount: amount.neg().toFixed() },
            { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: NATIVE_SYMBOL, amount: amount.toFixed() },
          );
        } else {
          items.push(
            { account: walletAccount, currency: NATIVE_SYMBOL, amount: amount.toFixed() },
            { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: NATIVE_SYMBOL, amount: amount.neg().toFixed() },
          );
        }
      }
    }

    // WRC-20 transfers.
    for (const t of g.tokenTransfers) {
      let meta;
      try {
        meta = await wanClient.getTokenMeta(t.contract, signal);
      } catch (e) {
        result.warnings.push(`token meta ${t.contract.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      await ensureCurrency(meta.symbol, meta.decimals, t.contract);
      const amount = toDecimal(t.value, meta.decimals);
      if (amount.isZero()) continue;

      const isTokenOut = t.from.toLowerCase() === addr;
      const isTokenIn = t.to.toLowerCase() === addr;
      if (!isTokenOut && !isTokenIn) continue;

      const counterparty = isTokenOut ? t.to : t.from;
      if (isTokenOut) {
        items.push(
          { account: walletAccount, currency: meta.symbol, amount: amount.neg().toFixed() },
          { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: meta.symbol, amount: amount.toFixed() },
        );
      } else {
        items.push(
          { account: walletAccount, currency: meta.symbol, amount: amount.toFixed() },
          { account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: meta.symbol, amount: amount.neg().toFixed() },
        );
      }
    }

    // Gas fee (sender only).
    if (isSender && g.gasUsed !== "0" && g.gasPrice !== "0") {
      await ensureCurrency(NATIVE_SYMBOL, NATIVE_DECIMALS);
      const feeWei = new Decimal(g.gasUsed).times(g.gasPrice);
      const fee = feeWei.dividedBy(new Decimal(10).pow(NATIVE_DECIMALS));
      if (!fee.isZero()) {
        items.push(
          { account: walletAccount, currency: NATIVE_SYMBOL, amount: fee.neg().toFixed() },
          { account: chainFees(CHAIN), currency: NATIVE_SYMBOL, amount: fee.toFixed() },
        );
      }
    }

    if (items.length === 0) {
      result.transactions_skipped++;
      continue;
    }

    // Description.
    const tokenCount = g.tokenTransfers.length;
    const direction: "sent" | "received" | "self" =
      isSender && isReceiver ? "self" : isSender ? "sent" : "received";
    const primaryCurrency =
      valueWei !== "0" ? NATIVE_SYMBOL :
      (g.tokenTransfers[0] ? (await wanClient.getTokenMeta(g.tokenTransfers[0].contract, signal).catch(() => ({ symbol: "?" } as { symbol: string }))).symbol : NATIVE_SYMBOL);
    const descData = tokenCount > 0 && valueWei === "0"
      ? onchainContractDescription(CHAIN, primaryCurrency, "internal-transfer", g.hash)
      : onchainTransferDescription(CHAIN, primaryCurrency, direction, {
          counterparty: shortAddr(isSender ? g.to ?? "" : g.from),
          txHash: g.hash,
          tokenCount,
        });

    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId, date,
      description: renderDescription(descData),
      description_data: JSON.stringify(descData),
      status: "confirmed", source, voided_by: null, created_at: date,
    };

    const lineItems: LineItem[] = [];
    for (const item of items) {
      const accountId = await ensureAccount(item.account, date);
      lineItems.push({
        id: uuidv7(), journal_entry_id: entryId, account_id: accountId,
        currency: item.currency, amount: item.amount, lot_id: null,
      });
    }

    try {
      await backend.postJournalEntry(entry, lineItems);
      await backend.setMetadata(entryId, {
        "wanchain:tx_hash": g.hash,
        "wanchain:block": String(g.blockNumber),
        "wanchain:from": g.from,
        "wanchain:to": g.to ?? "",
        "wanchain:token_count": String(tokenCount),
      });
      existingSources.add(source);
      result.transactions_imported++;
    } catch (e) {
      result.warnings.push(`post ${g.hash.slice(0, 10)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Cursor update ─────────────────────────────────────
  const nextCursor = Math.max(maxBlock, latest);
  if (nextCursor > cursorBlock) {
    await backend.updateBlockchainAccountCursor(account.id, String(nextCursor));
  }

  onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
  if (result.transactions_imported > 0) {
    invalidate("journal", "accounts", "reports");
  }
  return result;
}
