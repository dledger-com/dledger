/**
 * Synchronous host implementations backed by pre-loaded in-memory data.
 *
 * These avoid JSPI by pre-loading data from wa-sqlite before plugin execution,
 * and flushing writes back to the database after plugin execution.
 */

import { v7 as uuidv7 } from "uuid";
import type {
  AccountInfo,
  CurrencyBalance,
  LedgerReadImports,
  LedgerWriteImports,
  PluginStorageImports,
  QueryParams,
  Transaction,
  PricePoint,
} from "./types.js";

// ---- Plugin Storage (sync, in-memory Map) ----

export interface SyncPluginStorageState {
  data: Map<string, string>;
  dirty: boolean;
}

export function createSyncPluginStorage(
  state: SyncPluginStorageState,
): PluginStorageImports {
  return {
    get(key: string): string | undefined {
      return state.data.get(key);
    },
    set(key: string, value: string): void {
      state.data.set(key, value);
      state.dirty = true;
    },
    delete(key: string): void {
      state.data.delete(key);
      state.dirty = true;
    },
    listKeys(): string[] {
      return Array.from(state.data.keys());
    },
  };
}

// ---- Ledger Write (sync, collects in memory) ----

export interface SyncLedgerWriteState {
  /** Pre-loaded accounts: full_name → id */
  accountMap: Map<string, string>;
  /** Newly created accounts to flush */
  newAccounts: {
    id: string;
    parentId: string | null;
    accountType: string;
    name: string;
    fullName: string;
  }[];
  /** Collected transactions to flush */
  transactions: {
    entryId: string;
    date: string;
    description: string;
    source: string;
    postings: { id: string; accountId: string; currency: string; amount: string }[];
  }[];
  /** Collected prices to flush */
  prices: {
    id: string;
    date: string;
    fromCurrency: string;
    toCurrency: string;
    rate: string;
    source: string;
  }[];
}

export function createSyncLedgerWrite(
  state: SyncLedgerWriteState,
  pluginName: string,
): LedgerWriteImports {
  return {
    submitTransactions(transactions: Transaction[]): number {
      let count = 0;
      for (const tx of transactions) {
        const entryId = uuidv7();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
          console.warn(`[plugin:${pluginName}] Skipping tx with invalid date: ${tx.date}`);
          continue;
        }

        state.transactions.push({
          entryId,
          date: tx.date,
          description: tx.description,
          source: `plugin:${pluginName}`,
          postings: tx.postings.map((p) => ({
            id: uuidv7(),
            accountId: p.account,
            currency: p.amount.currency,
            amount: p.amount.amount,
          })),
        });

        count++;
      }
      return count;
    },

    submitPrices(prices: PricePoint[]): number {
      let count = 0;
      for (const pp of prices) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pp.date)) {
          console.warn(`[plugin:${pluginName}] Skipping price with invalid date: ${pp.date}`);
          continue;
        }
        state.prices.push({
          id: uuidv7(),
          date: pp.date,
          fromCurrency: pp.fromCurrency,
          toCurrency: pp.toCurrency,
          rate: pp.rate,
          source: pp.source,
        });
        count++;
      }
      return count;
    },

    ensureAccount(fullName: string, accountType: string): string {
      // Check in-memory cache first
      const existing = state.accountMap.get(fullName);
      if (existing) return existing;

      // Validate
      const validTypes = ["asset", "liability", "equity", "revenue", "expense"];
      if (!validTypes.includes(accountType)) {
        throw "invalid-input";
      }

      const accountId = uuidv7();
      const name = fullName.split(":").pop() || fullName;

      // Find parent
      const segments = fullName.split(":");
      let parentId: string | null = null;
      if (segments.length > 1) {
        const parentName = segments.slice(0, -1).join(":");
        parentId = state.accountMap.get(parentName) ?? null;
      }

      // Add to in-memory cache
      state.accountMap.set(fullName, accountId);

      // Collect for flushing
      state.newAccounts.push({
        id: accountId,
        parentId,
        accountType,
        name,
        fullName,
      });

      return accountId;
    },
  };
}

// ---- Ledger Read (sync, pre-loaded data) ----

export interface SyncLedgerReadState {
  accounts: AccountInfo[];
  accountMap: Map<string, AccountInfo>;
  /** All journal entries with their line items, grouped by entry ID */
  entries: {
    id: string;
    date: string;
    description: string;
    items: { accountId: string; currency: string; amount: string }[];
  }[];
  exchangeRates: { fromCurrency: string; toCurrency: string; date: string; rate: string }[];
  /** Closure table: ancestor_id → descendant_ids */
  closureMap: Map<string, string[]>;
}

export function createSyncLedgerRead(
  state: SyncLedgerReadState,
): LedgerReadImports {
  return {
    listAccounts(): AccountInfo[] {
      return state.accounts;
    },

    getAccount(id: string): AccountInfo | undefined {
      return state.accountMap.get(id);
    },

    queryTransactions(params: QueryParams): Transaction[] {
      let filtered = state.entries;

      if (params.accountFilter) {
        filtered = filtered.filter((e) =>
          e.items.some((i) => i.accountId === params.accountFilter),
        );
      }
      if (params.fromDate) {
        filtered = filtered.filter((e) => e.date >= params.fromDate);
      }
      if (params.toDate) {
        filtered = filtered.filter((e) => e.date <= params.toDate);
      }

      // Sort by date descending
      filtered = [...filtered].sort((a, b) => b.date.localeCompare(a.date));

      // Apply offset and limit
      const offset = params.offset || 0;
      const limit = params.limit || 1000;
      filtered = filtered.slice(offset, offset + limit);

      return filtered.map((e) => ({
        date: e.date,
        description: e.description,
        postings: e.items.map((i) => ({
          account: i.accountId,
          amount: { amount: i.amount, currency: i.currency },
        })),
        metadata: [],
      }));
    },

    getBalance(accountId: string, asOf: string): CurrencyBalance[] {
      const totals = new Map<string, number>();
      for (const entry of state.entries) {
        if (asOf && entry.date >= asOf) continue;
        for (const item of entry.items) {
          if (item.accountId === accountId) {
            totals.set(
              item.currency,
              (totals.get(item.currency) ?? 0) + Number(item.amount),
            );
          }
        }
      }
      return Array.from(totals.entries())
        .map(([currency, amount]) => ({ currency, amount: String(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    },

    getBalanceWithChildren(accountId: string, asOf: string): CurrencyBalance[] {
      const descendants = state.closureMap.get(accountId) ?? [accountId];
      const descendantSet = new Set(descendants);

      const totals = new Map<string, number>();
      for (const entry of state.entries) {
        if (asOf && entry.date >= asOf) continue;
        for (const item of entry.items) {
          if (descendantSet.has(item.accountId)) {
            totals.set(
              item.currency,
              (totals.get(item.currency) ?? 0) + Number(item.amount),
            );
          }
        }
      }
      return Array.from(totals.entries())
        .map(([currency, amount]) => ({ currency, amount: String(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    },

    getExchangeRate(
      fromCurrency: string,
      toCurrency: string,
      date: string,
    ): string | undefined {
      // Find latest rate on or before the given date
      let best: { date: string; rate: string } | undefined;
      for (const r of state.exchangeRates) {
        if (
          r.fromCurrency === fromCurrency &&
          r.toCurrency === toCurrency &&
          r.date <= date
        ) {
          if (!best || r.date > best.date) {
            best = { date: r.date, rate: r.rate };
          }
        }
      }
      return best?.rate;
    },
  };
}
