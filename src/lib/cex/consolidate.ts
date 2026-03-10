import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem, EtherscanAccount } from "../types/index.js";
import { SUPPORTED_CHAINS } from "../types/index.js";
import type { HandlerContext, HandlerResult, TxHashGroup } from "../handlers/types.js";

/** Structural type for handler registry — accepts both HandlerRegistry and IndexedHandlerRegistry */
interface HandlerRegistryLike {
  processGroup(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult & { handlerId: string; warnings?: string[] }>;
}
import { inferAccountType } from "../browser-etherscan.js";
import { remapCounterpartyAccounts, mergeItemAccums, resolveToLineItems } from "../handlers/item-builder.js";
import type { ItemAccum } from "../handlers/item-builder.js";
import { normalizeTxid } from "./pipeline.js";

import type { TaskProgress } from "../task-queue.svelte.js";

interface CexIndexEntry {
  entry: JournalEntry;
  items: LineItem[];
  exchangeId: string;
}

export interface ConsolidationOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: TaskProgress) => void;
}

export interface ConsolidationPair {
  cexEntryId: string;
  cexSource: string;
  etherscanEntryId: string;
  etherscanSource: string;
  txid: string;
}

export interface ConsolidationResult {
  pairs_found: number;
  pairs_consolidated: number;
  pairs_skipped: number;
  warnings: string[];
  pairs: ConsolidationPair[];
}

/**
 * Retroactively consolidate CEX deposit/withdrawal entries with matching
 * Etherscan entries. Both entries must already exist in the journal.
 *
 * For each match:
 * - Voids both old entries
 * - Re-processes the Etherscan raw data through the handler registry
 *   with Equity:*:External:* remapped to the CEX asset account
 * - Falls back to direct line item remapping if no raw data available
 * - Marks the new entry with `cex_linked` metadata to prevent re-consolidation
 */
export async function retroactiveConsolidate(
  backend: Backend,
  registry: HandlerRegistryLike,
  options?: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    pairs_found: 0,
    pairs_consolidated: 0,
    pairs_skipped: 0,
    warnings: [],
    pairs: [],
  };

  const signal = options?.signal;
  const onProgress = options?.onProgress;
  const dryRun = options?.dryRun ?? false;

  onProgress?.({ current: 0, total: 0, message: "Loading entries..." });

  // 1. Load all non-voided entries with metadata
  const allEntries = await backend.queryJournalEntries({});
  const nonVoided: Array<[JournalEntry, LineItem[]]> = [];
  for (const pair of allEntries) {
    if (!pair[0].voided_by) {
      nonVoided.push(pair);
    }
  }

  // 2. Build indexes
  // CEX entries with txid metadata (not already consolidated)
  const cexEntriesWithTxid = new Map<string, CexIndexEntry>();
  // CEX deposit/withdrawal entries WITHOUT txid (fallback matching)
  const cexEntriesWithoutTxid: CexIndexEntry[] = [];
  // Etherscan entries by normalized hash (not already consolidated)
  const etherscanEntriesByHash = new Map<string, { entry: JournalEntry; items: LineItem[] }>();

  for (const [entry, items] of nonVoided) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    if (entry.source.startsWith("etherscan:")) {
      // Etherscan entry — extract hash from source (etherscan:{chainId}:{hash})
      const meta = await backend.getMetadata(entry.id);
      if (meta["cex_linked"]) continue; // already consolidated

      const parts = entry.source.split(":");
      if (parts.length >= 3) {
        const hash = normalizeTxid(parts.slice(2).join(":"));
        etherscanEntriesByHash.set(hash, { entry, items });
      }
    } else {
      // Potential CEX entry
      const meta = await backend.getMetadata(entry.id);
      if (meta["cex_linked"]) continue; // already consolidated
      if (!meta["exchange"]) continue; // not a CEX entry

      const cexData: CexIndexEntry = { entry, items, exchangeId: meta["exchange"] };

      if (meta["txid"]) {
        const normalizedTxid = normalizeTxid(meta["txid"]);
        cexEntriesWithTxid.set(normalizedTxid, cexData);
      } else {
        // Deposit/withdrawal without txid — candidate for fallback matching
        const isDepositOrWithdrawal = entry.description.includes(" deposit:") || entry.description.includes(" withdrawal:");
        if (isDepositOrWithdrawal) {
          cexEntriesWithoutTxid.push(cexData);
        }
      }
    }
  }

  // 3. Match by normalized txid (primary)
  const matchedEthHashes = new Set<string>();
  const matchedCexIds = new Set<string>();
  const pairs: Array<{
    txid: string;
    cex: CexIndexEntry;
    etherscan: { entry: JournalEntry; items: LineItem[] };
  }> = [];

  for (const [txid, cexData] of cexEntriesWithTxid) {
    const ethData = etherscanEntriesByHash.get(txid);
    if (ethData) {
      pairs.push({ txid, cex: cexData, etherscan: ethData });
      matchedEthHashes.add(txid);
      matchedCexIds.add(cexData.entry.id);
    }
  }

  // 4. Fallback: match CEX entries without txid by amount + currency + date
  const accountList = await backend.listAccounts();
  const accountIdToName = new Map<string, string>();
  for (const acc of accountList) {
    accountIdToName.set(acc.id, acc.full_name);
  }

  for (const cexData of cexEntriesWithoutTxid) {
    if (matchedCexIds.has(cexData.entry.id)) continue;

    // Extract the CEX asset movement: find the Assets:* line item
    const cexAsset = extractCexAssetMovement(cexData.items, accountIdToName);
    if (!cexAsset) continue;

    // For a CEX deposit (+amount): look for an Etherscan entry where the user's
    // wallet sends the same currency with a similar amount on a close date.
    // For a CEX withdrawal (-amount): look for an Etherscan entry where the
    // user's wallet receives the same currency.
    const isDeposit = new Decimal(cexAsset.amount).gt(0);
    const cexAmount = new Decimal(cexAsset.amount).abs();
    const cexDate = new Date(cexData.entry.date + "T00:00:00Z").getTime();

    let bestMatch: { hash: string; ethData: { entry: JournalEntry; items: LineItem[] } } | null = null;
    let bestDateDiff = Infinity;

    for (const [hash, ethData] of etherscanEntriesByHash) {
      if (matchedEthHashes.has(hash)) continue;

      // Check date proximity (within 2 days — blockchain confirmations can cause date drift)
      const ethDate = new Date(ethData.entry.date + "T00:00:00Z").getTime();
      const dateDiffDays = Math.abs(ethDate - cexDate) / (1000 * 60 * 60 * 24);
      if (dateDiffDays > 2) continue;

      // Look for a matching asset movement in the Etherscan entry
      // For deposits: user's wallet should have negative (outgoing) amount in the same currency
      // For withdrawals: user's wallet should have positive (incoming) amount
      const ethMovement = extractEtherscanWalletMovement(ethData.items, accountIdToName, cexAsset.currency);
      if (!ethMovement) continue;

      const ethAmount = new Decimal(ethMovement.amount).abs();
      const ethIsOutgoing = new Decimal(ethMovement.amount).lt(0);

      // Direction must match: deposit ↔ outgoing, withdrawal ↔ incoming
      if (isDeposit !== ethIsOutgoing) continue;

      // Amount must be close (allow up to 5% difference for gas/fees)
      const ratio = cexAmount.gt(0) ? ethAmount.div(cexAmount) : new Decimal(0);
      if (ratio.lt(0.95) || ratio.gt(1.05)) continue;

      // Prefer closest date
      if (dateDiffDays < bestDateDiff) {
        bestDateDiff = dateDiffDays;
        bestMatch = { hash, ethData };
      }
    }

    if (bestMatch) {
      pairs.push({ txid: `fallback:${bestMatch.hash}`, cex: cexData, etherscan: bestMatch.ethData });
      matchedEthHashes.add(bestMatch.hash);
      matchedCexIds.add(cexData.entry.id);
    }
  }

  result.pairs_found = pairs.length;
  result.pairs = pairs.map((p) => ({
    cexEntryId: p.cex.entry.id,
    cexSource: p.cex.entry.source,
    etherscanEntryId: p.etherscan.entry.id,
    etherscanSource: p.etherscan.entry.source,
    txid: p.txid,
  }));

  if (dryRun || pairs.length === 0) {
    return result;
  }

  // 4. Load caches for account/currency creation
  const etherscanAccounts = await backend.listEtherscanAccounts();
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // 5. Process each pair
  for (let i = 0; i < pairs.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress?.({ current: i, total: pairs.length, message: "Consolidating entries..." });

    const pair = pairs[i];
    const etherscanSource = pair.etherscan.entry.source;

    // Derive CEX target account from the CEX entry's asset account
    let cexAssetAccount: string | null = null;
    for (const item of pair.cex.items) {
      for (const [name, acc] of accountMap) {
        if (acc.id === item.account_id && name.startsWith("Assets:")) {
          cexAssetAccount = name;
          break;
        }
      }
      if (cexAssetAccount) break;
    }

    if (!cexAssetAccount) {
      result.warnings.push(`No asset account found in CEX entry ${pair.cex.entry.source} — skipping`);
      result.pairs_skipped++;
      continue;
    }

    // Try raw data re-processing first
    const rawData = await backend.getRawTransaction(etherscanSource);

    backend.beginTransaction?.();
    try {
      if (rawData) {
        // Re-process through handler registry with remap
        const consolidated = await consolidateViaHandlers(
          backend,
          registry,
          etherscanSource,
          rawData,
          cexAssetAccount,
          pair.cex.exchangeId,
          pair.cex.entry,
          pair.etherscan.entry,
          etherscanAccounts,
          accountMap,
          currencySet,
        );
        if (!consolidated.ok) {
          // Fall back to direct remap
          await consolidateDirectRemap(
            backend,
            pair.cex.entry,
            pair.cex.items,
            pair.etherscan.entry,
            pair.etherscan.items,
            cexAssetAccount,
            pair.cex.exchangeId,
            accountMap,
            currencySet,
          );
        }
        if (consolidated.warning) result.warnings.push(consolidated.warning);
      } else {
        // No raw data — fall back to direct line item remap
        await consolidateDirectRemap(
          backend,
          pair.cex.entry,
          pair.cex.items,
          pair.etherscan.entry,
          pair.etherscan.items,
          cexAssetAccount,
          pair.cex.exchangeId,
          accountMap,
          currencySet,
        );
      }

      backend.commitTransaction?.();
      result.pairs_consolidated++;
    } catch (e) {
      backend.rollbackTransaction?.();
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`Consolidation failed for txid ${pair.txid}: ${msg}`);
      result.pairs_skipped++;
    }
  }

  onProgress?.({ current: pairs.length, total: pairs.length, message: "Done" });
  return result;
}

/**
 * Extract the Assets:* line item from a CEX deposit/withdrawal entry.
 * Returns the currency and signed amount (positive = deposit, negative = withdrawal).
 */
function extractCexAssetMovement(
  items: LineItem[],
  accountIdToName: Map<string, string>,
): { currency: string; amount: string } | null {
  for (const item of items) {
    const name = accountIdToName.get(item.account_id);
    if (name?.startsWith("Assets:")) {
      return { currency: item.currency, amount: item.amount };
    }
  }
  return null;
}

/**
 * Extract the user's wallet movement from an Etherscan entry for a specific currency.
 * Looks for Assets:* line items (not Equity/Expenses) with the matching currency.
 */
function extractEtherscanWalletMovement(
  items: LineItem[],
  accountIdToName: Map<string, string>,
  currency: string,
): { amount: string } | null {
  for (const item of items) {
    if (item.currency !== currency) continue;
    const name = accountIdToName.get(item.account_id);
    if (name?.startsWith("Assets:")) {
      return { amount: item.amount };
    }
  }
  return null;
}

/**
 * Consolidate by re-processing Etherscan raw data through the handler registry
 * with counterparty accounts remapped to the CEX asset account.
 */
async function consolidateViaHandlers(
  backend: Backend,
  registry: HandlerRegistryLike,
  etherscanSource: string,
  rawData: string,
  cexTargetAccount: string,
  cexExchangeId: string,
  cexEntry: JournalEntry,
  etherscanEntry: JournalEntry,
  etherscanAccounts: EtherscanAccount[],
  accountMap: Map<string, Account>,
  currencySet: Set<string>,
): Promise<{ ok: boolean; warning?: string }> {
  // Parse source to get chainId
  const sourceParts = etherscanSource.split(":");
  const chainId = parseInt(sourceParts[1], 10);
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) {
    return { ok: false, warning: `Unknown chain ${chainId}` };
  }

  const group = JSON.parse(rawData) as TxHashGroup;

  // Find user address from etherscan accounts
  const chainAccounts = etherscanAccounts.filter((a) => a.chain_id === chainId);
  if (chainAccounts.length === 0) {
    return { ok: false, warning: `No Etherscan account found for chain ${chainId}` };
  }

  let userAddress = chainAccounts[0].address.toLowerCase();
  if (chainAccounts.length > 1 && group.normal) {
    const fromAddr = group.normal.from.toLowerCase();
    const toAddr = group.normal.to.toLowerCase();
    const fromMatch = chainAccounts.find((a) => a.address.toLowerCase() === fromAddr);
    const toMatch = chainAccounts.find((a) => a.address.toLowerCase() === toAddr);
    userAddress = (fromMatch ?? toMatch)?.address.toLowerCase() ?? userAddress;
  }

  // Build handler context
  const ctx = {
    address: userAddress,
    chainId,
    label: "",
    chain,
    backend,
    settings: {} as import("../data/settings.svelte.js").AppSettings,
    async ensureAccount(fullName: string, date: string): Promise<string> {
      return ensureAccountHelper(backend, accountMap, fullName, date);
    },
    async ensureCurrency(code: string, decimals: number): Promise<void> {
      if (currencySet.has(code)) return;
      await backend.createCurrency({ code, asset_type: "", param: "", name: code, decimal_places: decimals, is_base: false });
      currencySet.add(code);
    },
  };

  let handlerResult;
  try {
    handlerResult = await registry.processGroup(group, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, warning: `Handler error for ${etherscanSource}: ${msg}` };
  }

  if (handlerResult.type === "skip" || (handlerResult.type !== "entries" && handlerResult.type !== "review")) {
    return { ok: false };
  }

  // Void both old entries
  await backend.voidJournalEntry(cexEntry.id);
  await backend.voidJournalEntry(etherscanEntry.id);

  // Re-post with remapped accounts
  for (const handlerEntry of handlerResult.entries) {
    const items: ItemAccum[] = handlerEntry.items.map((item) => {
      const fullName = [...accountMap.entries()].find(([, acc]) => acc.id === item.account_id)?.[0] ?? item.account_id;
      return { account: fullName, currency: item.currency, amount: new Decimal(item.amount) };
    });

    const remapped = remapCounterpartyAccounts(items, [
      { from: "Equity:*:External:*", to: cexTargetAccount },
    ]);
    const merged = mergeItemAccums(remapped);

    for (const item of merged) {
      await ctx.ensureCurrency(item.currency, 8);
      await ctx.ensureAccount(item.account, handlerEntry.entry.date);
    }

    const resolvedItems = await resolveToLineItems(merged, handlerEntry.entry.date, ctx);

    const entryId = uuidv7();
    const newEntry: JournalEntry = {
      id: entryId,
      date: handlerEntry.entry.date,
      description: cexEntry.description,
      status: handlerEntry.entry.status,
      source: handlerEntry.entry.source,
      voided_by: null,
      created_at: handlerEntry.entry.date,
    };

    const lineItems: LineItem[] = resolvedItems.map((item) => ({
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: item.account_id,
      currency: item.currency,
      amount: item.amount,
      lot_id: item.lot_id,
    }));

    await backend.postJournalEntry(newEntry, lineItems);
    await backend.setMetadata(entryId, {
      ...handlerEntry.metadata,
      cex_linked: cexExchangeId,
    });
  }

  return { ok: true };
}

/**
 * Fallback consolidation: directly remap Etherscan entry's line items
 * to replace Equity:*:External:* with the CEX asset account.
 */
async function consolidateDirectRemap(
  backend: Backend,
  cexEntry: JournalEntry,
  _cexItems: LineItem[],
  etherscanEntry: JournalEntry,
  etherscanItems: LineItem[],
  cexTargetAccount: string,
  cexExchangeId: string,
  accountMap: Map<string, Account>,
  currencySet: Set<string>,
): Promise<void> {
  // Void both old entries
  await backend.voidJournalEntry(cexEntry.id);
  await backend.voidJournalEntry(etherscanEntry.id);

  // Build remapped items from the Etherscan entry
  const newItems: Array<{ account: string; currency: string; amount: Decimal }> = [];
  for (const item of etherscanItems) {
    let fullName: string | undefined;
    for (const [name, acc] of accountMap) {
      if (acc.id === item.account_id) {
        fullName = name;
        break;
      }
    }
    if (!fullName) fullName = item.account_id;

    // Remap Equity:*:External:* to CEX asset account
    const remappedName = (fullName.startsWith("Equity:") && fullName.includes(":External:"))
      ? cexTargetAccount
      : fullName;

    newItems.push({
      account: remappedName,
      currency: item.currency,
      amount: new Decimal(item.amount),
    });
  }

  // Ensure accounts and currencies
  for (const item of newItems) {
    if (!currencySet.has(item.currency)) {
      await backend.createCurrency({ code: item.currency, asset_type: "", param: "", name: item.currency, decimal_places: 8, is_base: false });
      currencySet.add(item.currency);
    }
    await ensureAccountHelper(backend, accountMap, item.account, etherscanEntry.date);
  }

  // Post the remapped entry with Etherscan source
  const entryId = uuidv7();
  const newEntry: JournalEntry = {
    id: entryId,
    date: etherscanEntry.date,
    description: cexEntry.description,
    status: "confirmed",
    source: etherscanEntry.source,
    voided_by: null,
    created_at: etherscanEntry.date,
  };

  const lineItems: LineItem[] = newItems.map((item) => ({
    id: uuidv7(),
    journal_entry_id: entryId,
    account_id: accountMap.get(item.account)!.id,
    currency: item.currency,
    amount: item.amount.toFixed(),
    lot_id: null,
  }));

  await backend.postJournalEntry(newEntry, lineItems);

  // Copy Etherscan metadata and add cex_linked
  const existingMeta = await backend.getMetadata(etherscanEntry.id);
  await backend.setMetadata(entryId, { ...existingMeta, cex_linked: cexExchangeId });
}

/** Helper to ensure an account exists with all parent accounts. */
async function ensureAccountHelper(
  backend: Backend,
  accountMap: Map<string, Account>,
  fullName: string,
  date: string,
): Promise<string> {
  const existing = accountMap.get(fullName);
  if (existing) return existing.id;

  const accountType = inferAccountType(fullName);
  const parts = fullName.split(":");
  let parentId: string | null = null;

  for (let depth = 1; depth < parts.length; depth++) {
    const ancestorName = parts.slice(0, depth).join(":");
    const existingAncestor = accountMap.get(ancestorName);
    if (existingAncestor) {
      parentId = existingAncestor.id;
    } else {
      const id = uuidv7();
      const acc: Account = {
        id,
        parent_id: parentId,
        account_type: accountType,
        name: parts[depth - 1],
        full_name: ancestorName,
        allowed_currencies: [],
        is_postable: true,
        is_archived: false,
        created_at: date,
      };
      await backend.createAccount(acc);
      accountMap.set(ancestorName, acc);
      parentId = id;
    }
  }

  const id = uuidv7();
  const acc: Account = {
    id,
    parent_id: parentId,
    account_type: accountType,
    name: parts[parts.length - 1],
    full_name: fullName,
    allowed_currencies: [],
    is_postable: true,
    is_archived: false,
    created_at: date,
  };
  await backend.createAccount(acc);
  accountMap.set(fullName, acc);
  return id;
}
