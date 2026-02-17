/**
 * Creates a ledger-read host implementation backed by wa-sqlite.
 * Mirrors src-tauri/src/plugin/host_impl.rs ledger-read section.
 */

import type { WaSqliteDb } from "../db/wa-sqlite.js";
import type {
  AccountInfo,
  CurrencyBalance,
  LedgerReadImports,
  QueryParams,
  Transaction,
} from "./types.js";

export function createLedgerRead(db: WaSqliteDb): LedgerReadImports {
  return {
    listAccounts(): AccountInfo[] {
      // jco calls these synchronously — but our wa-sqlite is async.
      // We store cached data and refresh it before each plugin run.
      throw new Error("listAccounts: use async wrapper");
    },
    getAccount(_id: string): AccountInfo | undefined {
      throw new Error("getAccount: use async wrapper");
    },
    queryTransactions(_params: QueryParams): Transaction[] {
      throw new Error("queryTransactions: use async wrapper");
    },
    getBalance(_accountId: string, _asOf: string): CurrencyBalance[] {
      throw new Error("getBalance: use async wrapper");
    },
    getBalanceWithChildren(_accountId: string, _asOf: string): CurrencyBalance[] {
      throw new Error("getBalanceWithChildren: use async wrapper");
    },
    getExchangeRate(_from: string, _to: string, _date: string): string | undefined {
      throw new Error("getExchangeRate: use async wrapper");
    },
  };
}

/**
 * Creates an async-capable ledger-read implementation.
 * With jco --instantiation async, host imports CAN be async.
 * The plugin will await the host call results.
 */
export function createAsyncLedgerRead(db: WaSqliteDb): LedgerReadImports {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl: any = {
    async listAccounts(): Promise<AccountInfo[]> {
      const rows = await db.query(
        `SELECT id, full_name, account_type, is_postable
         FROM account ORDER BY full_name`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        fullName: r.full_name as string,
        accountType: r.account_type as string,
        isPostable: (r.is_postable as number) !== 0,
      }));
    },

    async getAccount(id: string): Promise<AccountInfo | undefined> {
      const r = await db.queryOne(
        `SELECT id, full_name, account_type, is_postable
         FROM account WHERE id = ?1`,
        [id],
      );
      if (!r) return undefined;
      return {
        id: r.id as string,
        fullName: r.full_name as string,
        accountType: r.account_type as string,
        isPostable: (r.is_postable as number) !== 0,
      };
    },

    async queryTransactions(params: QueryParams): Promise<Transaction[]> {
      let sql = `SELECT DISTINCT je.id, je.date, je.description
         FROM journal_entry je`;
      const conditions: string[] = [];
      const sqlParams: (string | number)[] = [];

      if (params.accountFilter) {
        sql += " JOIN line_item li ON li.journal_entry_id = je.id";
        sqlParams.push(params.accountFilter);
        conditions.push(`li.account_id = ?${sqlParams.length}`);
      }
      if (params.fromDate) {
        sqlParams.push(params.fromDate);
        conditions.push(`je.date >= ?${sqlParams.length}`);
      }
      if (params.toDate) {
        sqlParams.push(params.toDate);
        conditions.push(`je.date <= ?${sqlParams.length}`);
      }

      if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
      sql += " ORDER BY je.date DESC, je.created_at DESC";

      sqlParams.push(params.limit);
      sql += ` LIMIT ?${sqlParams.length}`;
      sqlParams.push(params.offset);
      sql += ` OFFSET ?${sqlParams.length}`;

      const entries = await db.query(sql, sqlParams);

      const results: Transaction[] = [];
      for (const entry of entries) {
        const items = await db.query(
          `SELECT account_id, amount, currency FROM line_item WHERE journal_entry_id = ?1`,
          [entry.id as string],
        );
        results.push({
          date: entry.date as string,
          description: entry.description as string,
          postings: items.map((li) => ({
            account: li.account_id as string,
            amount: {
              amount: li.amount as string,
              currency: li.currency as string,
            },
          })),
          metadata: [],
        });
      }
      return results;
    },

    async getBalance(accountId: string, asOf: string): Promise<CurrencyBalance[]> {
      let sql = `SELECT li.currency, li.amount
         FROM line_item li
         JOIN journal_entry je ON je.id = li.journal_entry_id
         WHERE li.account_id = ?1`;
      const params: (string | number)[] = [accountId];

      if (asOf) {
        params.push(asOf);
        sql += ` AND je.date < ?${params.length}`;
      }

      const rows = await db.query(sql, params);
      const totals = new Map<string, number>();
      for (const r of rows) {
        const cur = r.currency as string;
        totals.set(cur, (totals.get(cur) ?? 0) + Number(r.amount));
      }
      return Array.from(totals.entries())
        .map(([currency, amount]) => ({ currency, amount: String(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    },

    async getBalanceWithChildren(accountId: string, asOf: string): Promise<CurrencyBalance[]> {
      const subtree = await db.query(
        "SELECT descendant_id FROM account_closure WHERE ancestor_id = ?1",
        [accountId],
      );
      if (subtree.length === 0) return [];

      const ids = subtree.map((r) => r.descendant_id as string);
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
      let sql = `SELECT li.currency, li.amount
         FROM line_item li
         JOIN journal_entry je ON je.id = li.journal_entry_id
         WHERE li.account_id IN (${placeholders})`;
      const params: (string | number)[] = [...ids];

      if (asOf) {
        params.push(asOf);
        sql += ` AND je.date < ?${params.length}`;
      }

      const rows = await db.query(sql, params);
      const totals = new Map<string, number>();
      for (const r of rows) {
        const cur = r.currency as string;
        totals.set(cur, (totals.get(cur) ?? 0) + Number(r.amount));
      }
      return Array.from(totals.entries())
        .map(([currency, amount]) => ({ currency, amount: String(amount) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
    },

    async getExchangeRate(
      fromCurrency: string,
      toCurrency: string,
      date: string,
    ): Promise<string | undefined> {
      const row = await db.queryOne(
        `SELECT rate FROM exchange_rate
         WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3
         ORDER BY date DESC LIMIT 1`,
        [fromCurrency, toCurrency, date],
      );
      return row ? (row.rate as string) : undefined;
    },
  };
  return impl as LedgerReadImports;
}
