import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { HandlerRegistry } from "./registry.js";
import type { HandlerContext, TxHashGroup } from "./types.js";
import type {
  Account,
  JournalEntry,
  LineItem,
  EtherscanSyncResult,
} from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { SUPPORTED_CHAINS } from "../types/index.js";
import {
  fetchPaginated,
  groupByHash,
  inferAccountType,
  type NormalTx,
  type InternalTx,
  type Erc20Tx,
  type Erc721Tx,
  type Erc1155Tx,
} from "../browser-etherscan.js";

// --- Reprocess types ---

export interface ReprocessOptions {
  chainId: number;
  address: string;
  label: string;
  settings: AppSettings;
  hashes?: string[];
  onProgress?: (processed: number, total: number) => void;
}

export interface ReprocessChange {
  hash: string;
  oldHandler: string;
  newHandler: string;
  oldDescription: string;
  newDescription: string;
}

export interface ReprocessResult {
  total: number;
  unchanged: number;
  changed: number;
  skipped: number;
  errors: string[];
  changes: ReprocessChange[];
}

export async function syncEtherscanWithHandlers(
  backend: Backend,
  registry: HandlerRegistry,
  apiKey: string,
  address: string,
  label: string,
  chainId: number,
  settings: AppSettings,
): Promise<EtherscanSyncResult> {
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  const result: EtherscanSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const addr = address.toLowerCase();

  // Build caches
  const currencySet = new Set(
    (await backend.listCurrencies()).map((c) => c.code),
  );
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Collect existing sources for dedup
  const entries = await backend.queryJournalEntries({});
  const existingSources = new Set<string>();
  const chainPrefix = `etherscan:${chainId}:`;
  for (const [e] of entries) {
    if (!e.source.startsWith("etherscan:")) continue;
    existingSources.add(e.source);
    // Backward compat for chain_id=1
    if (chainId === 1 && !e.source.startsWith("etherscan:1:")) {
      const rest = e.source.substring("etherscan:".length);
      if (rest.startsWith("0x")) {
        existingSources.add(`etherscan:1:${rest}`);
      } else if (rest.startsWith("int:")) {
        existingSources.add(`etherscan:1:${rest}`);
        const parts = rest.split(":");
        if (parts.length >= 2) {
          existingSources.add(`etherscan:1:${parts[1]}`);
        }
      }
    }
    // Backward compat: old internal sources
    if (e.source.startsWith(chainPrefix)) {
      const afterPrefix = e.source.substring(chainPrefix.length);
      if (afterPrefix.startsWith("int:")) {
        const parts = afterPrefix.split(":");
        if (parts.length >= 2) {
          existingSources.add(`etherscan:${chainId}:${parts[1]}`);
        }
      }
    }
  }

  // Context helpers
  async function ensureCurrency(
    code: string,
    decimals: number,
  ): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: decimals,
      is_base: false,
    });
    currencySet.add(code);
  }

  async function ensureAccount(
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
        result.accounts_created++;
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
    result.accounts_created++;
    return id;
  }

  // Build handler context
  const ctx: HandlerContext = {
    address: addr,
    chainId,
    label,
    chain,
    backend,
    settings,
    ensureAccount,
    ensureCurrency,
  };

  // Ensure native currency
  await ensureCurrency(chain.native_currency, chain.decimals);

  // Fetch all 5 transfer types (with rate-limiting delays)
  const normalTxns = await fetchPaginated<NormalTx>(
    apiKey,
    addr,
    "txlist",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const internalTxns = await fetchPaginated<InternalTx>(
    apiKey,
    addr,
    "txlistinternal",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc20Txns = await fetchPaginated<Erc20Tx>(
    apiKey,
    addr,
    "tokentx",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc721Txns = await fetchPaginated<Erc721Tx>(
    apiKey,
    addr,
    "tokennfttx",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc1155Txns = await fetchPaginated<Erc1155Tx>(
    apiKey,
    addr,
    "token1155tx",
    chainId,
  );

  // Group by hash
  const groups = groupByHash(
    normalTxns,
    internalTxns,
    erc20Txns,
    erc721Txns,
    erc1155Txns,
  );

  // Sort groups by timestamp and process
  const sortedGroups = Array.from(groups.values()).sort((a, b) => {
    const aTs = parseInt(a.timestamp, 10) || 0;
    const bTs = parseInt(b.timestamp, 10) || 0;
    return aTs - bTs;
  });

  for (const group of sortedGroups) {
    const source = `etherscan:${chainId}:${group.hash}`;

    // Dedup check
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
    }

    // Store raw transaction data for future re-processing
    try {
      await backend.storeRawTransaction(source, JSON.stringify(group));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`store raw tx ${group.hash}: ${msg}`);
    }

    // Process through handler registry
    const handlerResult = await registry.processGroup(group, ctx);

    if (handlerResult.warnings) {
      result.warnings.push(...handlerResult.warnings);
    }

    if (handlerResult.type === "skip") {
      continue;
    }

    if (handlerResult.type === "entries" || handlerResult.type === "review") {
      for (const handlerEntry of handlerResult.entries) {
        const entryId = uuidv7();
        const entry: JournalEntry = {
          id: entryId,
          date: handlerEntry.entry.date,
          description: handlerEntry.entry.description,
          status: handlerEntry.entry.status,
          source: handlerEntry.entry.source,
          voided_by: handlerEntry.entry.voided_by,
          created_at: handlerEntry.entry.date,
        };

        const items: LineItem[] = handlerEntry.items.map((item) => ({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: item.account_id,
          currency: item.currency,
          amount: item.amount,
          lot_id: item.lot_id,
        }));

        try {
          await backend.postJournalEntry(entry, items);
          if (Object.keys(handlerEntry.metadata).length > 0) {
            await backend.setMetadata(entryId, handlerEntry.metadata);
          }
          result.transactions_imported++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          result.warnings.push(`post tx ${group.hash}: ${msg}`);
        }
      }
    }
  }

  return result;
}

// --- Reprocess helpers ---

function buildHandlerContext(
  backend: Backend,
  address: string,
  chainId: number,
  label: string,
  settings: AppSettings,
  accountMap: Map<string, Account>,
  currencySet: Set<string>,
): HandlerContext {
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  async function ensureCurrency(code: string, decimals: number): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: decimals,
      is_base: false,
    });
    currencySet.add(code);
  }

  async function ensureAccount(fullName: string, date: string): Promise<string> {
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

  return {
    address: address.toLowerCase(),
    chainId,
    label,
    chain,
    backend,
    settings,
    ensureAccount,
    ensureCurrency,
  };
}

/** Serialise line items into a comparable string for change detection */
function canonicalItems(items: Omit<LineItem, "id" | "journal_entry_id">[]): string {
  return items
    .map((i) => `${i.account_id}|${i.currency}|${i.amount}`)
    .sort()
    .join(";");
}

/**
 * Dry-run reprocess: compare current handler output to existing entries.
 * Returns a summary of what would change without mutating the journal.
 */
export async function dryRunReprocess(
  backend: Backend,
  registry: HandlerRegistry,
  options: ReprocessOptions,
): Promise<ReprocessResult> {
  const { chainId, address, label, settings, hashes, onProgress } = options;
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  const result: ReprocessResult = {
    total: 0,
    unchanged: 0,
    changed: 0,
    skipped: 0,
    errors: [],
    changes: [],
  };

  // Fetch raw transactions
  let rawTxns: Array<{ source: string; data: string }>;
  if (hashes && hashes.length > 0) {
    rawTxns = [];
    for (const hash of hashes) {
      const source = `etherscan:${chainId}:${hash}`;
      const data = await backend.getRawTransaction(source);
      if (data) rawTxns.push({ source, data });
    }
  } else {
    rawTxns = await backend.queryRawTransactions(`etherscan:${chainId}:`);
  }

  result.total = rawTxns.length;

  // Build caches
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Build existing entries index by source
  const allEntries = await backend.queryJournalEntries({});
  const entryBySource = new Map<string, { entry: JournalEntry; items: LineItem[] }>();
  for (const [entry, items] of allEntries) {
    if (entry.voided_by) continue; // skip voided entries
    entryBySource.set(entry.source, { entry, items });
  }

  // Build handler context
  const ctx = buildHandlerContext(backend, address, chainId, label, settings, accountMap, currencySet);

  // Ensure native currency
  await ctx.ensureCurrency(chain.native_currency, chain.decimals);

  // Sort by timestamp and process
  const sorted = rawTxns.sort((a, b) => {
    const aGroup = JSON.parse(a.data) as TxHashGroup;
    const bGroup = JSON.parse(b.data) as TxHashGroup;
    return (parseInt(aGroup.timestamp, 10) || 0) - (parseInt(bGroup.timestamp, 10) || 0);
  });

  for (let i = 0; i < sorted.length; i++) {
    const { source, data } = sorted[i];
    try {
      const group = JSON.parse(data) as TxHashGroup;

      // Run through current handler config
      const handlerResult = await registry.processGroup(group, ctx);

      if (handlerResult.type === "skip") {
        // Check if there's an existing entry — if so, this is a change (would become skipped)
        const existing = entryBySource.get(source);
        if (existing) {
          const existingMeta = await backend.getMetadata(existing.entry.id);
          result.changed++;
          result.changes.push({
            hash: group.hash,
            oldHandler: existingMeta["handler"] ?? "unknown",
            newHandler: handlerResult.handlerId,
            oldDescription: existing.entry.description,
            newDescription: `(skipped: ${handlerResult.reason})`,
          });
        } else {
          result.skipped++;
        }
        continue;
      }

      if (handlerResult.type === "entries" || handlerResult.type === "review") {
        const existing = entryBySource.get(source);
        if (!existing) {
          // No existing entry — this raw tx was never posted (unusual but possible)
          result.skipped++;
          continue;
        }

        const existingMeta = await backend.getMetadata(existing.entry.id);
        const oldHandler = existingMeta["handler"] ?? "unknown";
        const newHandler = handlerResult.handlerId;

        // Compare first entry (primary)
        const newEntry = handlerResult.entries[0];
        const oldDesc = existing.entry.description;
        const newDesc = newEntry.entry.description;
        const oldItems = canonicalItems(existing.items);
        const newItems = canonicalItems(newEntry.items);

        if (oldHandler === newHandler && oldDesc === newDesc && oldItems === newItems) {
          result.unchanged++;
        } else {
          result.changed++;
          result.changes.push({
            hash: group.hash,
            oldHandler,
            newHandler,
            oldDescription: oldDesc,
            newDescription: newDesc,
          });
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${source}: ${msg}`);
    }

    onProgress?.(i + 1, sorted.length);
  }

  return result;
}

/**
 * Apply reprocess: void existing entries for changed hashes and re-post
 * with current handler output. Wrapped in a transaction for atomicity.
 */
export async function applyReprocess(
  backend: Backend,
  registry: HandlerRegistry,
  options: ReprocessOptions,
  changes: ReprocessChange[],
): Promise<ReprocessResult> {
  const { chainId, address, label, settings, onProgress } = options;
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  const result: ReprocessResult = {
    total: changes.length,
    unchanged: 0,
    changed: 0,
    skipped: 0,
    errors: [],
    changes: [],
  };

  // Build caches
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Build existing entries index by source
  const allEntries = await backend.queryJournalEntries({});
  const entryBySource = new Map<string, { entry: JournalEntry; items: LineItem[] }>();
  for (const [entry, items] of allEntries) {
    if (entry.voided_by) continue;
    entryBySource.set(entry.source, { entry, items });
  }

  // Build handler context
  const ctx = buildHandlerContext(backend, address, chainId, label, settings, accountMap, currencySet);

  // Ensure native currency
  await ctx.ensureCurrency(chain.native_currency, chain.decimals);

  // Build set of hashes to apply
  const changeHashes = new Set(changes.map((c) => c.hash));

  // Begin transaction if supported
  backend.beginTransaction?.();

  try {
    let processed = 0;
    for (const hash of changeHashes) {
      const source = `etherscan:${chainId}:${hash}`;

      try {
        // Get raw transaction data
        const rawData = await backend.getRawTransaction(source);
        if (!rawData) {
          result.errors.push(`${hash}: raw transaction not found`);
          continue;
        }

        const group = JSON.parse(rawData) as TxHashGroup;

        // Void existing entry
        const existing = entryBySource.get(source);
        if (existing) {
          await backend.voidJournalEntry(existing.entry.id);
        }

        // Re-run handler
        const handlerResult = await registry.processGroup(group, ctx);

        if (handlerResult.type === "skip") {
          result.changed++;
          continue;
        }

        if (handlerResult.type === "entries" || handlerResult.type === "review") {
          for (const handlerEntry of handlerResult.entries) {
            const entryId = uuidv7();
            const entry: JournalEntry = {
              id: entryId,
              date: handlerEntry.entry.date,
              description: handlerEntry.entry.description,
              status: handlerEntry.entry.status,
              source: handlerEntry.entry.source,
              voided_by: handlerEntry.entry.voided_by,
              created_at: handlerEntry.entry.date,
            };

            const items: LineItem[] = handlerEntry.items.map((item) => ({
              id: uuidv7(),
              journal_entry_id: entryId,
              account_id: item.account_id,
              currency: item.currency,
              amount: item.amount,
              lot_id: item.lot_id,
            }));

            await backend.postJournalEntry(entry, items);
            if (Object.keys(handlerEntry.metadata).length > 0) {
              await backend.setMetadata(entryId, handlerEntry.metadata);
            }
          }
          result.changed++;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`${hash}: ${msg}`);
      }

      processed++;
      onProgress?.(processed, changeHashes.size);
    }

    backend.commitTransaction?.();
  } catch (e: unknown) {
    backend.rollbackTransaction?.();
    throw e;
  }

  return result;
}
