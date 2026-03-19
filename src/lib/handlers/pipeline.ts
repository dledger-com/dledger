import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { HandlerContext, HandlerResult, TxHashGroup } from "./types.js";

/** Structural type for handler registry — accepts both HandlerRegistry and IndexedHandlerRegistry */
interface HandlerRegistryLike {
  processGroup(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult & { handlerId: string; warnings?: string[] }>;
  getAll(): { id: string; name: string }[];
}
import type {
  Account,
  ChainInfo,
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
  weiToNative,
  calculateGasFee,
  type NormalTx,
  type InternalTx,
  type Erc20Tx,
  type Erc721Tx,
  type Erc1155Tx,
} from "../browser-etherscan.js";
import Decimal from "decimal.js-light";
import { isAToken, isDebtToken } from "./aave.js";
import { isAavePool, AAVE } from "./addresses.js";
import { prefetchAaveSubgraphBatch, clearAaveSubgraphCache } from "./aave-subgraph.js";
import { remapCounterpartyAccounts, mergeItemAccums, resolveToLineItems } from "./item-builder.js";
import type { ItemAccum } from "./item-builder.js";
import { normalizeTxid } from "../cex/pipeline.js";
import { deriveAndRecordTradeRate } from "../utils/derive-trade-rate.js";
import type { TradeRateItem } from "../utils/derive-trade-rate.js";
import { chainIdToDefiLlamaChain } from "../exchange-rate-historical.js";

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
  currencyHints: Record<string, { source: string | null; handler: string }>; // currency → { source hint, handler id }
}

/**
 * Build tx-level metadata from a TxHashGroup for injection into journal entries.
 * This captures raw transaction details (addresses, gas, chain info) that would
 * otherwise be lost after handler processing.
 */
export function buildTxGroupMetadata(group: TxHashGroup, chain: ChainInfo): Record<string, string> {
  const meta: Record<string, string> = {};

  meta["tx:hash"] = group.hash;
  meta["tx:chain_id"] = String(chain.chain_id);
  meta["tx:chain_name"] = chain.name;

  if (group.normal) {
    const n = group.normal;
    meta["tx:from"] = n.from;
    meta["tx:to"] = n.to;
    meta["tx:status"] = n.isError === "0" ? "success" : "failed";

    if (n.value && n.value !== "0") {
      meta["tx:value"] = weiToNative(n.value, chain.decimals).toFixed();
    }
    if (n.gasUsed && n.gasUsed !== "0") {
      meta["tx:gas_used"] = n.gasUsed;
    }
    if (n.gasPrice && n.gasPrice !== "0") {
      meta["tx:gas_price_gwei"] = new Decimal(n.gasPrice).dividedBy(1e9).toFixed();
    }
    const gasFee = calculateGasFee(n.gasUsed, n.gasPrice, chain.decimals);
    if (!gasFee.isZero()) {
      meta["tx:gas_fee"] = gasFee.toFixed();
    }
    if (n.blockNumber) {
      meta["tx:block"] = n.blockNumber;
    }
    if (n.nonce) {
      meta["tx:nonce"] = n.nonce;
    }
    if (n.functionName) {
      meta["tx:function"] = n.functionName;
    }
  }

  if (group.erc20s.length > 0) {
    meta["tx:erc20_count"] = String(group.erc20s.length);
    const contracts = [...new Set(group.erc20s.map((t) => t.contractAddress.toLowerCase()))];
    meta["tx:contracts"] = contracts.join(",");
  }
  if (group.internals.length > 0) {
    meta["tx:internal_count"] = String(group.internals.length);
  }
  const nftCount = group.erc721s.length + group.erc1155s.length;
  if (nftCount > 0) {
    meta["tx:nft_count"] = String(nftCount);
  }

  return meta;
}

export async function syncEtherscanWithHandlers(
  backend: Backend,
  registry: HandlerRegistryLike,
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

  // Reverse lookup: account id → full name
  function accountNameById(id: string): string {
    for (const [name, acc] of accountMap) {
      if (acc.id === id) return name;
    }
    return id;
  }

  // Collect existing sources for dedup + build entries-by-id for cross-source consolidation
  const allLoadedEntries = await backend.queryJournalEntries({});
  const existingSources = new Set<string>();
  const entriesById = new Map<string, [JournalEntry, LineItem[]]>();
  const chainPrefix = `etherscan:${chainId}:`;
  for (const pair of allLoadedEntries) {
    const [e] = pair;
    if (!e.voided_by) {
      entriesById.set(e.id, pair);
    }
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
    contractAddress?: string,
  ): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      asset_type: "",
      param: "",
      name: code,
      decimal_places: decimals,
      is_base: false,
    });
    currencySet.add(code);
    // Record token address for DeFi pricing (first-seen wins via INSERT OR IGNORE)
    if (contractAddress && chain) {
      const llamaChain = chainIdToDefiLlamaChain(chain.chain_id);
      if (llamaChain) {
        await backend.setCurrencyTokenAddress(code, llamaChain, contractAddress.toLowerCase());
      }
    }
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
  const routescanKey = settings.routescanApiKey || undefined;
  const normalTxns = await fetchPaginated<NormalTx>(
    apiKey,
    addr,
    "txlist",
    chainId,
    routescanKey,
  );

  await new Promise((r) => setTimeout(r, 250));
  const internalTxns = await fetchPaginated<InternalTx>(
    apiKey,
    addr,
    "txlistinternal",
    chainId,
    routescanKey,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc20Txns = await fetchPaginated<Erc20Tx>(
    apiKey,
    addr,
    "tokentx",
    chainId,
    routescanKey,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc721Txns = await fetchPaginated<Erc721Tx>(
    apiKey,
    addr,
    "tokennfttx",
    chainId,
    routescanKey,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc1155Txns = await fetchPaginated<Erc1155Tx>(
    apiKey,
    addr,
    "token1155tx",
    chainId,
    routescanKey,
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

  // Pre-scan for Aave groups and batch-prefetch enrichment data
  if ((settings.enrichmentEnabled ?? false) && settings.theGraphApiKey && settings.theGraphEnabled !== false) {
    const aaveEntries: { hash: string; isV2: boolean }[] = [];
    for (const group of sortedGroups) {
      const source = `etherscan:${chainId}:${group.hash}`;
      if (existingSources.has(source)) continue;
      const isAave = group.erc20s.some(t => isAToken(t.tokenSymbol) || isDebtToken(t.tokenSymbol))
        || (group.normal && isAavePool(group.normal.to, chainId));
      if (!isAave) continue;
      const isV2 = group.normal ? group.normal.to.toLowerCase() === AAVE.V2_POOL : false;
      aaveEntries.push({ hash: group.hash, isV2 });
    }
    if (aaveEntries.length > 0) {
      await prefetchAaveSubgraphBatch(settings.theGraphApiKey, chainId, aaveEntries);
    }
  }

  for (const group of sortedGroups) {
    const source = `etherscan:${chainId}:${group.hash}`;

    // Store raw transaction data for (re-)processing — always, even if entry exists
    try {
      await backend.storeRawTransaction(source, JSON.stringify(group));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`store raw tx ${group.hash}: ${msg}`);
    }

    // Dedup check
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
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
      // Check for matching CEX entry to consolidate (Etherscan→CEX direction)
      let cexConsolidated = false;
      const cexMatchIds = await backend.queryEntriesByMetadata("txid", normalizeTxid(group.hash));
      if (cexMatchIds.length > 0) {
        const cexMatch = cexMatchIds
          .map((id) => entriesById.get(id))
          .find((m) => m && !m[0].voided_by);

        if (cexMatch) {
          const [cexEntry, cexItems] = cexMatch;

          // Extract CEX asset account from matched entry's line items
          let cexAssetAccount: string | null = null;
          for (const item of cexItems) {
            for (const [name, acc] of accountMap) {
              if (acc.id === item.account_id && name.startsWith("Assets:")) {
                cexAssetAccount = name;
                break;
              }
            }
            if (cexAssetAccount) break;
          }

          if (cexAssetAccount) {
            try {
              // Void the CEX entry
              await backend.voidJournalEntry(cexEntry.id);
              entriesById.delete(cexEntry.id);

              // Remap and post each handler entry with CEX asset account as counterparty
              for (const handlerEntry of handlerResult.entries) {
                const accums: ItemAccum[] = handlerEntry.items.map((item) => {
                  let fullName = item.account_id;
                  for (const [name, acc] of accountMap) {
                    if (acc.id === item.account_id) { fullName = name; break; }
                  }
                  return { account: fullName, currency: item.currency, amount: new Decimal(item.amount) };
                });

                const remapped = remapCounterpartyAccounts(accums, [
                  { from: "Equity:*:External:*", to: cexAssetAccount },
                ]);
                const merged = mergeItemAccums(remapped);
                const resolved = await resolveToLineItems(merged, handlerEntry.entry.date, ctx);

                const entryId = uuidv7();
                const newEntry: JournalEntry = {
                  id: entryId,
                  date: handlerEntry.entry.date,
                  description: handlerEntry.entry.description,
                  description_data: handlerEntry.entry.description_data,
                  status: handlerEntry.entry.status,
                  source: handlerEntry.entry.source,
                  voided_by: null,
                  created_at: handlerEntry.entry.date,
                };

                const lineItems: LineItem[] = resolved.map((item) => ({
                  id: uuidv7(),
                  journal_entry_id: entryId,
                  account_id: item.account_id,
                  currency: item.currency,
                  amount: item.amount,
                  lot_id: item.lot_id,
                }));

                await backend.postJournalEntry(newEntry, lineItems);
                const cexExchangeId = cexEntry.source.split(":")[0];
                const txMeta = buildTxGroupMetadata(group, chain);
                await backend.setMetadata(entryId, { ...txMeta, ...handlerEntry.metadata, cex_linked: cexExchangeId });

                // Derive and record exchange rate from consolidated items
                const cexRateItems: TradeRateItem[] = lineItems.map((li) => ({
                  account_name: accountNameById(li.account_id),
                  currency: li.currency,
                  amount: li.amount,
                }));
                await deriveAndRecordTradeRate(backend, handlerEntry.entry.date, cexRateItems);
              }

              cexConsolidated = true;
              result.transactions_imported++;
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              result.warnings.push(`CEX consolidation for tx ${group.hash}: ${msg}`);
            }
          }
        }
      }

      if (!cexConsolidated) {
        // Normal posting loop (no CEX match found)
        for (const handlerEntry of handlerResult.entries) {
          const entryId = uuidv7();
          const entry: JournalEntry = {
            id: entryId,
            date: handlerEntry.entry.date,
            description: handlerEntry.entry.description,
            description_data: handlerEntry.entry.description_data,
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
            const txMeta = buildTxGroupMetadata(group, chain);
            await backend.setMetadata(entryId, { ...txMeta, ...handlerEntry.metadata });

            // Derive and record exchange rate from handler items
            const normalRateItems: TradeRateItem[] = handlerEntry.items.map((item) => ({
              account_name: accountNameById(item.account_id),
              currency: item.currency,
              amount: item.amount,
            }));
            await deriveAndRecordTradeRate(backend, handlerEntry.entry.date, normalRateItems);

            result.transactions_imported++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            result.warnings.push(`post tx ${group.hash}: ${msg}`);
          }
        }
      }

      // Store currency hints as rate source entries
      if (handlerResult.currencyHints) {
        for (const [currency, source] of Object.entries(handlerResult.currencyHints)) {
          const rateSource = source ?? "none";
          await backend.setCurrencyRateSource(currency, rateSource, `handler:${handlerResult.handlerId}`);
        }
      }
    }
  }

  clearAaveSubgraphCache();

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

  async function ensureCurrency(code: string, decimals: number, contractAddress?: string): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      asset_type: "",
      param: "",
      name: code,
      decimal_places: decimals,
      is_base: false,
    });
    currencySet.add(code);
    if (contractAddress && chain) {
      const llamaChain = chainIdToDefiLlamaChain(chain.chain_id);
      if (llamaChain) {
        await backend.setCurrencyTokenAddress(code, llamaChain, contractAddress.toLowerCase());
      }
    }
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
    enrichment: settings.enrichmentEnabled ?? false,
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
  registry: HandlerRegistryLike,
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
    currencyHints: {},
  };

  // Fetch raw transactions (both etherscan and thegraph sources)
  let rawTxns: Array<{ source: string; data: string }>;
  if (hashes && hashes.length > 0) {
    rawTxns = [];
    for (const hash of hashes) {
      const ethSource = `etherscan:${chainId}:${hash}`;
      const ethData = await backend.getRawTransaction(ethSource);
      if (ethData) {
        rawTxns.push({ source: ethSource, data: ethData });
      } else {
        const graphSource = `thegraph:${chainId}:${hash}`;
        const graphData = await backend.getRawTransaction(graphSource);
        if (graphData) rawTxns.push({ source: graphSource, data: graphData });
      }
    }
  } else {
    rawTxns = await backend.queryRawTransactions(`etherscan:${chainId}:`);
    const graphTxns = await backend.queryRawTransactions(`thegraph:${chainId}:`);
    rawTxns.push(...graphTxns);
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

      // Set sourcePrefix based on raw transaction source
      ctx.sourcePrefix = source.startsWith("thegraph:") ? "thegraph" : undefined;

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
        // Collect currency hints regardless of change status
        if (handlerResult.currencyHints) {
          for (const [currency, source_] of Object.entries(handlerResult.currencyHints)) {
            result.currencyHints[currency] = { source: source_, handler: handlerResult.handlerId };
          }
        }
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
  registry: HandlerRegistryLike,
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
    currencyHints: {},
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
      // Try etherscan source first, then thegraph
      let source = `etherscan:${chainId}:${hash}`;
      let rawData = await backend.getRawTransaction(source);
      if (!rawData) {
        source = `thegraph:${chainId}:${hash}`;
        rawData = await backend.getRawTransaction(source);
      }

      try {
        // Get raw transaction data
        if (!rawData) {
          result.errors.push(`${hash}: raw transaction not found`);
          continue;
        }

        const group = JSON.parse(rawData) as TxHashGroup;

        // Set sourcePrefix based on raw transaction source
        ctx.sourcePrefix = source.startsWith("thegraph:") ? "thegraph" : undefined;

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
              description_data: handlerEntry.entry.description_data,
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
            const txMeta = buildTxGroupMetadata(group, chain);
            await backend.setMetadata(entryId, { ...txMeta, ...handlerEntry.metadata });
          }

          // Store currency hints as rate source entries
          if (handlerResult.currencyHints) {
            for (const [currency, source] of Object.entries(handlerResult.currencyHints)) {
              const rateSource = source ?? "none";
              await backend.setCurrencyRateSource(currency, rateSource, `handler:${handlerResult.handlerId}`);
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
