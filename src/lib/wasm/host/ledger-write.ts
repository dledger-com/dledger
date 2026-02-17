/**
 * Browser host implementation for the WIT ledger-write interface.
 * Mirrors src-tauri/src/plugin/host_impl.rs ledger_write::Host.
 *
 * With jco --instantiation async, host imports CAN be async.
 * The asyncify layer suspends WASM and resumes when Promises resolve.
 */

import { v7 as uuidv7 } from "uuid";
import type { WaSqliteDb } from "../db/wa-sqlite.js";
import type {
  Transaction,
  PricePoint,
  LedgerWriteImports,
} from "./types.js";

/**
 * Create the ledger-write host import object for a source plugin.
 * jco translates WIT `result<T, host-error>` → return T or throw string.
 */
export function createAsyncLedgerWrite(
  db: WaSqliteDb,
  pluginName: string,
): LedgerWriteImports {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl: any = {
    async submitTransactions(transactions: Transaction[]): Promise<number> {
      let count = 0;
      for (const tx of transactions) {
        const entryId = uuidv7();
        const today = new Date().toISOString().slice(0, 10);

        // Validate date
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
          console.warn(`[plugin:${pluginName}] Skipping tx with invalid date: ${tx.date}`);
          continue;
        }

        // Insert journal entry with "pending" status
        await db.exec(
          `INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          [entryId, tx.date, tx.description, "pending", `plugin:${pluginName}`, null, today],
        );

        // Insert line items
        for (const p of tx.postings) {
          await db.exec(
            `INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            [uuidv7(), entryId, p.account, p.amount.currency, p.amount.amount, null],
          );
        }

        // Audit log
        await db.exec(
          `INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [uuidv7(), today, "post", "journal_entry", entryId, tx.description],
        );

        count++;
      }

      return count;
    },

    async submitPrices(prices: PricePoint[]): Promise<number> {
      let count = 0;
      for (const pp of prices) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pp.date)) {
          console.warn(`[plugin:${pluginName}] Skipping price with invalid date: ${pp.date}`);
          continue;
        }

        await db.exec(
          `INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [uuidv7(), pp.date, pp.fromCurrency, pp.toCurrency, pp.rate, pp.source],
        );
        count++;
      }
      return count;
    },

    async ensureAccount(fullName: string, accountType: string): Promise<string> {
      // Check if account already exists
      const existing = await db.queryOne(
        "SELECT id FROM account WHERE full_name = ?1",
        [fullName],
      );
      if (existing) {
        return existing.id as string;
      }

      // Validate account type
      const validTypes = ["asset", "liability", "equity", "revenue", "expense"];
      if (!validTypes.includes(accountType)) {
        throw "invalid-input";
      }

      const accountId = uuidv7();
      const name = fullName.split(":").pop() || fullName;
      const today = new Date().toISOString().slice(0, 10);

      // Find parent account if path has segments
      const segments = fullName.split(":");
      let parentId: string | null = null;
      if (segments.length > 1) {
        const parentName = segments.slice(0, -1).join(":");
        const parentRow = await db.queryOne(
          "SELECT id FROM account WHERE full_name = ?1",
          [parentName],
        );
        if (parentRow) {
          parentId = parentRow.id as string;
        }
      }

      // Insert account
      await db.exec(
        `INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        [accountId, parentId, accountType, name, fullName, "[]", 1, 0, today],
      );

      // Insert closure table entries (self-reference)
      await db.exec(
        "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
        [accountId, accountId],
      );
      // Copy parent's ancestor relationships
      if (parentId) {
        await db.exec(
          `INSERT INTO account_closure (ancestor_id, descendant_id, depth)
           SELECT ancestor_id, ?1, depth + 1
           FROM account_closure
           WHERE descendant_id = ?2`,
          [accountId, parentId],
        );
      }

      // Audit log
      await db.exec(
        `INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [uuidv7(), today, "create", "account", accountId, fullName],
      );

      return accountId;
    },
  };
  return impl as LedgerWriteImports;
}
