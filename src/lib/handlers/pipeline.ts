import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { HandlerRegistry } from "./registry.js";
import type { HandlerContext } from "./types.js";
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
