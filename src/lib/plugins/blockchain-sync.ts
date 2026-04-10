/**
 * Generic sync orchestrator for plugin-provided blockchain sources.
 * Handles the common pagination, dedup, account/currency creation, and journal posting loop.
 */

import { v7 as uuidv7 } from "uuid";
import type { Backend, GenericBlockchainAccount } from "../backend.js";
import type { JournalEntry, LineItem, Account } from "../types/index.js";
import type { BlockchainSourceExtension, BlockchainProcessContext } from "./types.js";
import { ensureAccountHierarchy, ensureSyncCurrency } from "../sync-helpers.js";
import { invalidate } from "../data/invalidation.js";

export interface PluginSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

export async function syncPluginChain(
  backend: Backend,
  ext: BlockchainSourceExtension,
  account: GenericBlockchainAccount,
  config: Record<string, string>,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<PluginSyncResult> {
  const result: PluginSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  // Build caches
  const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);

  const sourcePrefix = `${ext.chainId}:`;
  const existingSources = new Set<string>();
  for (const [e] of await backend.queryJournalEntries({})) {
    if (e.source.startsWith(sourcePrefix)) existingSources.add(e.source);
  }

  const ctx: BlockchainProcessContext = {
    address: account.address,
    label: account.label,
    chainName: ext.chainName,
    symbol: ext.symbol,
  };

  let cursor = account.cursor;
  let totalProcessed = 0;

  // Pagination loop
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onProgress?.(`Fetching transactions${cursor ? " (page)" : ""}...`);

    let fetchResult;
    try {
      fetchResult = await ext.fetchTransactions(account.address, cursor, config, signal);
    } catch (e) {
      result.warnings.push(`Fetch error: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    const txs = fetchResult.transactions;
    if (txs.length === 0) break;

    for (let i = 0; i < txs.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      totalProcessed++;
      onProgress?.(`Processing ${totalProcessed}...`);

      const tx = txs[i];

      // Process transaction through plugin
      let processed;
      try {
        processed = ext.processTransaction(tx, ctx);
      } catch (e) {
        result.warnings.push(`Process ${tx.id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
        result.transactions_skipped++;
        continue;
      }

      if (!processed) {
        result.transactions_skipped++;
        continue;
      }

      // Deduplicate
      if (existingSources.has(processed.source)) {
        result.transactions_skipped++;
        continue;
      }

      if (processed.items.length === 0) {
        result.transactions_skipped++;
        continue;
      }

      // Store raw transaction
      try { await backend.storeRawTransaction(processed.source, JSON.stringify(tx)); } catch { /* may exist */ }

      // Ensure currencies and accounts exist, build line items
      const entryId = uuidv7();
      const lineItems: LineItem[] = [];

      for (const item of processed.items) {
        await ensureSyncCurrency(backend, item.currency, currencySet);
        const accountId = await ensureAccountHierarchy(backend, item.account, processed.date, accountMap, result);
        lineItems.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: accountId,
          currency: item.currency,
          amount: item.amount,
          lot_id: null,
        });
      }

      const entry: JournalEntry = {
        id: entryId,
        date: processed.date,
        description: processed.description,
        description_data: processed.descriptionData ?? undefined,
        status: "confirmed",
        source: processed.source,
        voided_by: null,
        created_at: processed.date,
      };

      try {
        await backend.postJournalEntry(entry, lineItems);
        if (processed.metadata) {
          await backend.setMetadata(entryId, processed.metadata);
        }
        existingSources.add(processed.source);
        result.transactions_imported++;
      } catch (e) {
        result.warnings.push(`Post ${tx.id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Update cursor after each page
    cursor = fetchResult.nextCursor ?? null;
    await backend.updateBlockchainAccountCursor(account.id, cursor);

    if (!fetchResult.nextCursor) break;
  }

  onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
  if (result.transactions_imported > 0) {
    invalidate("journal", "accounts", "reports");
  }

  return result;
}
