import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { HandlerContext, HandlerResult, TxHashGroup } from "./types.js";
import type {
  Account,
  ChainInfo,
  JournalEntry,
  LineItem,
  EtherscanSyncResult,
} from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { SUPPORTED_CHAINS } from "../types/index.js";
import { inferAccountType } from "../browser-etherscan.js";
import Decimal from "decimal.js-light";
import { remapCounterpartyAccounts, mergeItemAccums, resolveToLineItems } from "./item-builder.js";
import type { ItemAccum } from "./item-builder.js";
import { normalizeTxid } from "../cex/pipeline.js";
import { deriveAndRecordTradeRate } from "../utils/derive-trade-rate.js";
import type { TradeRateItem } from "../utils/derive-trade-rate.js";
import { chainIdToDefiLlamaChain } from "../exchange-rate-historical.js";
import { buildTxGroupMetadata } from "./pipeline.js";
import {
  fetchGraphTransfers,
  fetchGraphNftTransfers,
  convertGraphToTxHashGroups,
  isTheGraphSupportedChain,
  THE_GRAPH_NETWORK_MAP,
} from "../thegraph-token-api.js";

/** Structural type for handler registry — accepts both HandlerRegistry and IndexedHandlerRegistry */
interface HandlerRegistryLike {
  processGroup(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult & { handlerId: string; warnings?: string[] }>;
  getAll(): { id: string; name: string }[];
}

export async function syncTheGraphWithHandlers(
  backend: Backend,
  registry: HandlerRegistryLike,
  apiKey: string,
  address: string,
  label: string,
  chainId: number,
  settings: AppSettings,
): Promise<EtherscanSyncResult> {
  if (!isTheGraphSupportedChain(chainId)) {
    throw new Error(`The Graph Token API does not support chain_id: ${chainId}`);
  }

  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  const network = THE_GRAPH_NETWORK_MAP[chainId];

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

  function accountNameById(id: string): string {
    for (const [name, acc] of accountMap) {
      if (acc.id === id) return name;
    }
    return id;
  }

  // Collect existing sources for dedup (both thegraph and etherscan prefixes)
  const allLoadedEntries = await backend.queryJournalEntries({});
  const existingSources = new Set<string>();
  const entriesById = new Map<string, [JournalEntry, LineItem[]]>();
  for (const pair of allLoadedEntries) {
    const [e] = pair;
    if (!e.voided_by) {
      entriesById.set(e.id, pair);
    }
    existingSources.add(e.source);
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

  // Build handler context with sourcePrefix
  const ctx: HandlerContext = {
    address: addr,
    chainId,
    label,
    chain,
    backend,
    settings,
    sourcePrefix: "thegraph",
    ensureAccount,
    ensureCurrency,
  };

  // Ensure native currency
  await ensureCurrency(chain.native_currency, chain.decimals);

  // Fetch from The Graph Token API (2 calls instead of 5)
  const transfers = await fetchGraphTransfers(apiKey, addr, network);
  const nftTransfers = await fetchGraphNftTransfers(apiKey, addr, network);

  // Convert to TxHashGroup format
  const groups = convertGraphToTxHashGroups(transfers, nftTransfers, chain.decimals);

  // Sort groups by timestamp
  const sortedGroups = groups.sort((a, b) => {
    const aTs = parseInt(a.timestamp, 10) || 0;
    const bTs = parseInt(b.timestamp, 10) || 0;
    return aTs - bTs;
  });

  // No Aave subgraph prefetching — The Graph data lacks normal.to needed for handler matching

  for (const group of sortedGroups) {
    const source = `thegraph:${chainId}:${group.hash}`;

    // Store raw transaction data
    try {
      await backend.storeRawTransaction(source, JSON.stringify(group));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`store raw tx ${group.hash}: ${msg}`);
    }

    // Cross-source dedup: skip if already imported via Etherscan OR The Graph
    if (existingSources.has(source) || existingSources.has(`etherscan:${chainId}:${group.hash}`)) {
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
      // Check for matching CEX entry to consolidate
      let cexConsolidated = false;
      const cexMatchIds = await backend.queryEntriesByMetadata("txid", normalizeTxid(group.hash));
      if (cexMatchIds.length > 0) {
        const cexMatch = cexMatchIds
          .map((id) => entriesById.get(id))
          .find((m) => m && !m[0].voided_by);

        if (cexMatch) {
          const [cexEntry, cexItems] = cexMatch;

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
              await backend.voidJournalEntry(cexEntry.id);
              entriesById.delete(cexEntry.id);

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
                txMeta["tx:data_source"] = "thegraph";
                await backend.setMetadata(entryId, { ...txMeta, ...handlerEntry.metadata, cex_linked: cexExchangeId });

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
            const txMeta = buildTxGroupMetadata(group, chain);
            txMeta["tx:data_source"] = "thegraph";
            await backend.setMetadata(entryId, { ...txMeta, ...handlerEntry.metadata });

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

      // Store currency hints
      if (handlerResult.currencyHints) {
        for (const [currency, source] of Object.entries(handlerResult.currencyHints)) {
          const rateSource = source ?? "none";
          await backend.setCurrencyRateSource(currency, rateSource, `handler:${handlerResult.handlerId}`);
        }
      }
    }
  }

  return result;
}
