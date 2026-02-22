import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import type { Account, JournalEntry, LineItem, EtherscanAccount } from "../types/index.js";
import { SUPPORTED_CHAINS } from "../types/index.js";
import type { Backend } from "../backend.js";
import type { CexAdapter, CexLedgerRecord, CexSyncResult, ExchangeAccount } from "./types.js";
import { inferAccountType } from "../browser-etherscan.js";
import type { HandlerRegistry } from "../handlers/registry.js";
import { remapCounterpartyAccounts, mergeItemAccums, resolveToLineItems } from "../handlers/item-builder.js";
import type { ItemAccum } from "../handlers/item-builder.js";
import type { TxHashGroup } from "../handlers/types.js";

/**
 * Main sync orchestrator for any CEX adapter.
 */
export async function syncCexAccount(
  backend: Backend,
  adapter: CexAdapter,
  account: ExchangeAccount,
  registry?: HandlerRegistry,
): Promise<CexSyncResult> {
  const result: CexSyncResult = {
    entries_imported: 0,
    entries_skipped: 0,
    entries_consolidated: 0,
    accounts_created: 0,
    warnings: [],
  };

  // 1. Fetch all records
  const records = await adapter.fetchLedgerRecords(account.api_key, account.api_secret);

  // Enrich txids for deposits/withdrawals if adapter supports it
  if ("enrichTxids" in adapter && typeof (adapter as Record<string, unknown>).enrichTxids === "function") {
    await (adapter as { enrichTxids(r: CexLedgerRecord[], k: string, s: string): Promise<void> })
      .enrichTxids(records, account.api_key, account.api_secret);
  }

  // 2. Build dedup set from existing sources
  const allEntries = await backend.queryJournalEntries({});
  const existingSources = new Set<string>();
  for (const [entry] of allEntries) {
    if (!entry.voided_by) {
      existingSources.add(entry.source);
    }
  }

  // 3. Build caches
  const currencySet = new Set((await backend.listCurrencies()).map((c) => c.code));
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // 4. Load etherscan accounts for automatic consolidation
  const etherscanAccounts = await backend.listEtherscanAccounts();

  // Build entries-by-id map for metadata-based lookups
  const entriesById = new Map<string, [JournalEntry, LineItem[]]>();
  for (const pair of allEntries) {
    const [entry] = pair;
    if (!entry.voided_by) {
      entriesById.set(entry.id, pair);
    }
  }

  // Helper: ensure currency exists
  async function ensureCurrency(code: string): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: 8,
      is_base: false,
    });
    currencySet.add(code);
  }

  // Helper: ensure account exists (with parents)
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

  // Helper: post a journal entry from items
  async function postEntry(
    date: string,
    description: string,
    source: string,
    items: Array<{ account: string; currency: string; amount: Decimal }>,
    metadata?: Record<string, string>,
  ): Promise<void> {
    // Ensure currencies and accounts
    for (const item of items) {
      await ensureCurrency(item.currency);
      await ensureAccount(item.account, date);
    }

    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    const lineItems: LineItem[] = items.map((item) => ({
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: accountMap.get(item.account)!.id,
      currency: item.currency,
      amount: item.amount.toFixed(),
      lot_id: null,
    }));

    await backend.postJournalEntry(entry, lineItems);
    if (metadata && Object.keys(metadata).length > 0) {
      await backend.setMetadata(entryId, metadata);
    }
    result.entries_imported++;
  }

  // 5. Group trade records by refid
  const tradeGroups = new Map<string, CexLedgerRecord[]>();
  const nonTradeRecords: CexLedgerRecord[] = [];

  for (const record of records) {
    if (record.type === "trade") {
      const group = tradeGroups.get(record.refid) ?? [];
      group.push(record);
      tradeGroups.set(record.refid, group);
    } else {
      nonTradeRecords.push(record);
    }
  }

  // Sort by timestamp
  const sortedTradeRefids = [...tradeGroups.keys()].sort((a, b) => {
    const aTs = tradeGroups.get(a)![0].timestamp;
    const bTs = tradeGroups.get(b)![0].timestamp;
    return aTs - bTs;
  });
  nonTradeRecords.sort((a, b) => a.timestamp - b.timestamp);

  const exchangeName = adapter.exchangeName;

  // 6. Process trade pairs
  for (const refid of sortedTradeRefids) {
    const source = `${adapter.exchangeId}:${refid}`;
    if (existingSources.has(source)) {
      result.entries_skipped++;
      continue;
    }

    const group = tradeGroups.get(refid)!;
    if (group.length < 2) {
      result.warnings.push(`Trade ${refid}: expected pair, got ${group.length} record(s) — skipping`);
      result.entries_skipped++;
      continue;
    }

    const date = new Date(group[0].timestamp * 1000).toISOString().slice(0, 10);
    const items: Array<{ account: string; currency: string; amount: Decimal }> = [];
    const parts: string[] = [];

    for (const record of group) {
      const amount = new Decimal(record.amount);
      const fee = new Decimal(record.fee);

      // Asset account movement
      items.push({
        account: `Assets:${exchangeName}:${record.asset}`,
        currency: record.asset,
        amount,
      });

      // Equity:Trading counterpart (opposite sign)
      items.push({
        account: `Equity:Trading:${record.asset}`,
        currency: record.asset,
        amount: amount.neg(),
      });

      // Fee
      if (fee.gt(0)) {
        items.push({
          account: `Expenses:${exchangeName}:Fees`,
          currency: record.asset,
          amount: fee,
        });
        items.push({
          account: `Assets:${exchangeName}:${record.asset}`,
          currency: record.asset,
          amount: fee.neg(),
        });
      }

      if (amount.gt(0)) {
        parts.push(`+${amount.toFixed()} ${record.asset}`);
      } else {
        parts.push(`${amount.toFixed()} ${record.asset}`);
      }
    }

    const description = `${exchangeName} trade: ${parts.join(" / ")}`;
    await postEntry(date, description, source, items, {
      exchange: adapter.exchangeId,
      refid,
    });
    existingSources.add(source);
  }

  // 7. Process non-trade records
  for (const record of nonTradeRecords) {
    const source = `${adapter.exchangeId}:${record.refid}`;
    if (existingSources.has(source)) {
      result.entries_skipped++;
      continue;
    }

    const date = new Date(record.timestamp * 1000).toISOString().slice(0, 10);
    const amount = new Decimal(record.amount);
    const fee = new Decimal(record.fee);

    // Check for automatic cross-source consolidation
    if ((record.type === "deposit" || record.type === "withdrawal") && record.txid) {
      const txidLower = record.txid.toLowerCase();
      const cexTargetAccount = `Assets:${exchangeName}:${record.asset}`;

      // Try Etherscan source match first
      const etherscanSource = findEtherscanSourceByTxid(existingSources, record.txid);
      if (etherscanSource && registry) {
        const consolidated = await consolidateWithEtherscan(
          backend,
          registry,
          etherscanSource,
          cexTargetAccount,
          adapter,
          etherscanAccounts,
          accountMap,
          currencySet,
        );
        if (consolidated.consolidated) {
          result.entries_consolidated++;
          existingSources.add(source);
          if (consolidated.warning) result.warnings.push(consolidated.warning);
          continue;
        }
        if (consolidated.warning) result.warnings.push(consolidated.warning);
      }

      // Try CEX→CEX match (another exchange entry with same txid)
      if (!etherscanSource) {
        const cexMatchIds = await backend.queryEntriesByMetadata("txid", txidLower);
        const matchPair = cexMatchIds
          .map((id) => entriesById.get(id))
          .find((m) => m && !m[0].voided_by && !m[0].source.startsWith(adapter.exchangeId + ":"));
        if (matchPair) {
          const consolidated = await consolidateWithCex(
            backend,
            matchPair,
            cexTargetAccount,
            adapter,
            accountMap,
            currencySet,
          );
          if (consolidated.consolidated) {
            result.entries_consolidated++;
            existingSources.add(source);
            if (consolidated.warning) result.warnings.push(consolidated.warning);
            continue;
          }
          if (consolidated.warning) result.warnings.push(consolidated.warning);
        }
      }
    }

    switch (record.type) {
      case "deposit": {
        const items: Array<{ account: string; currency: string; amount: Decimal }> = [
          { account: `Assets:${exchangeName}:${record.asset}`, currency: record.asset, amount },
          { account: `Equity:${exchangeName}:External`, currency: record.asset, amount: amount.neg() },
        ];
        await postEntry(date, `${exchangeName} deposit: ${amount.toFixed()} ${record.asset}`, source, items, {
          exchange: adapter.exchangeId,
          refid: record.refid,
          ...(record.txid ? { txid: record.txid.toLowerCase() } : {}),
        });
        break;
      }

      case "withdrawal": {
        const absAmount = amount.abs();
        const items: Array<{ account: string; currency: string; amount: Decimal }> = [
          { account: `Assets:${exchangeName}:${record.asset}`, currency: record.asset, amount: absAmount.neg() },
          { account: `Equity:${exchangeName}:External`, currency: record.asset, amount: fee.gt(0) ? absAmount.minus(fee) : absAmount },
        ];
        if (fee.gt(0)) {
          items.push({ account: `Expenses:${exchangeName}:Fees`, currency: record.asset, amount: fee });
        }
        await postEntry(date, `${exchangeName} withdrawal: ${absAmount.toFixed()} ${record.asset}`, source, items, {
          exchange: adapter.exchangeId,
          refid: record.refid,
          ...(record.txid ? { txid: record.txid.toLowerCase() } : {}),
        });
        break;
      }

      case "staking": {
        if (amount.gt(0)) {
          const items: Array<{ account: string; currency: string; amount: Decimal }> = [
            { account: `Assets:${exchangeName}:${record.asset}`, currency: record.asset, amount },
            { account: `Income:${exchangeName}:Staking`, currency: record.asset, amount: amount.neg() },
          ];
          await postEntry(date, `${exchangeName} staking reward: ${amount.toFixed()} ${record.asset}`, source, items, {
            exchange: adapter.exchangeId,
            refid: record.refid,
          });
        } else {
          // Staking deduction (e.g., unstaking fee)
          result.warnings.push(`Staking record ${record.refid} has negative amount — skipping`);
          result.entries_skipped++;
        }
        break;
      }

      case "transfer": {
        // Internal transfers (e.g., spot → futures) — skip, zero-sum within exchange
        result.entries_skipped++;
        break;
      }

      default: {
        result.warnings.push(`Unknown record type "${record.type}" for ${record.refid} — skipping`);
        result.entries_skipped++;
        break;
      }
    }

    existingSources.add(source);
  }

  // Update last_sync
  await backend.updateExchangeAccount(account.id, {
    last_sync: new Date().toISOString(),
  });

  return result;
}

/**
 * Find an Etherscan source string matching a given on-chain txid.
 */
export function findEtherscanSourceByTxid(
  existingSources: Set<string>,
  txid: string,
): string | null {
  const lowerTxid = txid.toLowerCase();
  for (const src of existingSources) {
    if (src.startsWith("etherscan:") && src.toLowerCase().endsWith(`:${lowerTxid}`)) {
      return src;
    }
  }
  return null;
}

/**
 * Consolidate an Etherscan entry with a CEX deposit/withdrawal.
 * Voids the old Etherscan entry and re-posts it with the CEX account as counterparty.
 * Derives chain/wallet info from the Etherscan source string and raw tx data.
 */
async function consolidateWithEtherscan(
  backend: Backend,
  registry: HandlerRegistry,
  etherscanSource: string,
  cexTargetAccount: string,
  adapter: CexAdapter,
  etherscanAccounts: EtherscanAccount[],
  accountMap: Map<string, Account>,
  currencySet: Set<string>,
): Promise<{ consolidated: boolean; warning?: string }> {
  // 1. Query existing entry
  const entries = await backend.queryJournalEntries({ source: etherscanSource });
  if (entries.length === 0) {
    return { consolidated: false, warning: `Etherscan entry not found for ${etherscanSource}` };
  }

  const [existingEntry] = entries[0];
  if (existingEntry.voided_by || existingEntry.status === "voided") {
    return { consolidated: false };
  }

  // 2. Get raw data for re-processing
  const rawData = await backend.getRawTransaction(etherscanSource);
  if (!rawData) {
    return { consolidated: false, warning: `No raw data for ${etherscanSource}, skipping reclassification` };
  }

  // 3. Derive chain/wallet from the etherscan source string + raw tx data
  const sourceParts = etherscanSource.split(":");
  const chainId = parseInt(sourceParts[1], 10);
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) {
    return { consolidated: false, warning: `Unknown chain ${chainId}` };
  }

  const group = JSON.parse(rawData) as TxHashGroup;

  // Find the user's address from etherscan accounts matching this chain
  const chainAccounts = etherscanAccounts.filter((a) => a.chain_id === chainId);
  if (chainAccounts.length === 0) {
    return { consolidated: false, warning: `No Etherscan account found for chain ${chainId}` };
  }

  let userAddress = chainAccounts[0].address.toLowerCase();
  if (chainAccounts.length > 1 && group.normal) {
    const fromAddr = group.normal.from.toLowerCase();
    const toAddr = group.normal.to.toLowerCase();
    const fromMatch = chainAccounts.find((a) => a.address.toLowerCase() === fromAddr);
    const toMatch = chainAccounts.find((a) => a.address.toLowerCase() === toAddr);
    userAddress = (fromMatch ?? toMatch)?.address.toLowerCase() ?? userAddress;
  }

  // Build a minimal handler context
  const ctx = {
    address: userAddress,
    chainId,
    label: "",
    chain,
    backend,
    settings: {} as import("../data/settings.svelte.js").AppSettings,
    async ensureAccount(fullName: string, date: string): Promise<string> {
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
    },
    async ensureCurrency(code: string, decimals: number): Promise<void> {
      if (currencySet.has(code)) return;
      await backend.createCurrency({
        code,
        name: code,
        decimal_places: decimals,
        is_base: false,
      });
      currencySet.add(code);
    },
  };

  let handlerResult;
  try {
    handlerResult = await registry.processGroup(group, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { consolidated: false, warning: `Handler error for ${etherscanSource}: ${msg}` };
  }

  if (handlerResult.type === "skip") {
    return { consolidated: false };
  }

  if (handlerResult.type !== "entries" && handlerResult.type !== "review") {
    return { consolidated: false };
  }

  // 4. Apply remap to handler entries
  backend.beginTransaction?.();
  try {
    // Void old entry
    await backend.voidJournalEntry(existingEntry.id);

    // Re-post with remapped accounts
    for (const handlerEntry of handlerResult.entries) {
      // Build ItemAccum from handler entry items for remapping
      const items: ItemAccum[] = handlerEntry.items.map((item) => {
        // Resolve account_id back to full_name
        const fullName = [...accountMap.entries()].find(([, acc]) => acc.id === item.account_id)?.[0] ?? item.account_id;
        return {
          account: fullName,
          currency: item.currency,
          amount: new Decimal(item.amount),
        };
      });

      const remapped = remapCounterpartyAccounts(items, [
        { from: "Equity:*:External:*", to: cexTargetAccount },
      ]);
      const merged = mergeItemAccums(remapped);

      // Ensure accounts and currencies for remapped items
      for (const item of merged) {
        await ctx.ensureCurrency(item.currency, 8);
        await ctx.ensureAccount(item.account, handlerEntry.entry.date);
      }

      const resolvedItems = await resolveToLineItems(merged, handlerEntry.entry.date, ctx);

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

      const lineItems: LineItem[] = resolvedItems.map((item) => ({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: item.account_id,
        currency: item.currency,
        amount: item.amount,
        lot_id: item.lot_id,
      }));

      await backend.postJournalEntry(newEntry, lineItems);
      const metadata = {
        ...handlerEntry.metadata,
        cex_linked: adapter.exchangeId,
      };
      await backend.setMetadata(entryId, metadata);
    }

    backend.commitTransaction?.();
  } catch (e) {
    backend.rollbackTransaction?.();
    const msg = e instanceof Error ? e.message : String(e);
    return { consolidated: false, warning: `Consolidation failed for ${etherscanSource}: ${msg}` };
  }

  return {
    consolidated: true,
    warning: `Consolidated: ${adapter.exchangeName} transfer matched Etherscan entry ${etherscanSource} — counterparty reclassified to ${cexTargetAccount}`,
  };
}

/**
 * Consolidate a CEX entry with another CEX entry (cross-exchange transfer).
 * Voids the existing entry and re-posts it with the new exchange's asset account as counterparty.
 */
async function consolidateWithCex(
  backend: Backend,
  existingPair: [JournalEntry, LineItem[]],
  cexTargetAccount: string,
  adapter: CexAdapter,
  accountMap: Map<string, Account>,
  currencySet: Set<string>,
): Promise<{ consolidated: boolean; warning?: string }> {
  const [existingEntry, existingItems] = existingPair;

  // Build id→name reverse lookup helper
  function getAccountName(id: string): string | undefined {
    for (const [name, acc] of accountMap) {
      if (acc.id === id) return name;
    }
    return undefined;
  }

  backend.beginTransaction?.();
  try {
    // Void the existing CEX entry
    await backend.voidJournalEntry(existingEntry.id);

    // Build items with remapped accounts
    const newItems: Array<{ account: string; currency: string; amount: Decimal }> = [];
    for (const item of existingItems) {
      const fullName = getAccountName(item.account_id) ?? item.account_id;
      // Remap Equity:*:External → cexTargetAccount (CEX external accounts are 3-segment)
      const remappedName = fullName.match(/^Equity:[^:]+:External$/) ? cexTargetAccount : fullName;
      newItems.push({
        account: remappedName,
        currency: item.currency,
        amount: new Decimal(item.amount),
      });
    }

    // Ensure accounts and currencies
    for (const item of newItems) {
      if (!currencySet.has(item.currency)) {
        await backend.createCurrency({ code: item.currency, name: item.currency, decimal_places: 8, is_base: false });
        currencySet.add(item.currency);
      }
      if (!accountMap.has(item.account)) {
        // Create account with parents
        const accountType = inferAccountType(item.account);
        const parts = item.account.split(":");
        let parentId: string | null = null;
        for (let depth = 1; depth < parts.length; depth++) {
          const ancestorName = parts.slice(0, depth).join(":");
          const existing = accountMap.get(ancestorName);
          if (existing) {
            parentId = existing.id;
          } else {
            const id = uuidv7();
            const acc: Account = {
              id, parent_id: parentId, account_type: accountType,
              name: parts[depth - 1], full_name: ancestorName,
              allowed_currencies: [], is_postable: true, is_archived: false,
              created_at: existingEntry.date,
            };
            await backend.createAccount(acc);
            accountMap.set(ancestorName, acc);
            parentId = id;
          }
        }
        const id = uuidv7();
        const acc: Account = {
          id, parent_id: parentId, account_type: accountType,
          name: parts[parts.length - 1], full_name: item.account,
          allowed_currencies: [], is_postable: true, is_archived: false,
          created_at: existingEntry.date,
        };
        await backend.createAccount(acc);
        accountMap.set(item.account, acc);
      }
    }

    // Post remapped entry
    const entryId = uuidv7();
    const newEntry: JournalEntry = {
      id: entryId,
      date: existingEntry.date,
      description: existingEntry.description,
      status: "confirmed",
      source: existingEntry.source,
      voided_by: null,
      created_at: existingEntry.date,
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

    // Copy existing metadata and add cex_linked
    const existingMeta = await backend.getMetadata(existingEntry.id);
    await backend.setMetadata(entryId, { ...existingMeta, cex_linked: adapter.exchangeId });

    backend.commitTransaction?.();
  } catch (e) {
    backend.rollbackTransaction?.();
    const msg = e instanceof Error ? e.message : String(e);
    return { consolidated: false, warning: `CEX consolidation failed for ${existingEntry.source}: ${msg}` };
  }

  return {
    consolidated: true,
    warning: `Consolidated: ${adapter.exchangeName} transfer matched CEX entry ${existingEntry.source} — counterparty reclassified to ${cexTargetAccount}`,
  };
}
