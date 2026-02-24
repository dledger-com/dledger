import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import type {
  Account,
  AccountType,
  Currency,
  JournalEntry,
  JournalEntryStatus,
  LineItem,
  TransactionFilter,
  CurrencyBalance,
  TrialBalance,
  TrialBalanceLine,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
  GainLossLine,
  ExchangeRate,
  OpenLot,
  Budget,
  LedgerImportResult,
  EtherscanAccount,
  EtherscanSyncResult,
  CurrencyOrigin,
  BalanceAssertion,
  BalanceAssertionResult,
} from "./types/index.js";
import type { Backend, CurrencyRateSource, Reconciliation, RecurringTemplate, UnreconciledLineItem } from "./backend.js";

// ---- IndexedDB persistence ----

const IDB_NAME = "dledger";
const IDB_STORE = "database";
const IDB_KEY = "main";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIndexedDB(data: Uint8Array): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(data, IDB_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const getReq = tx.objectStore(IDB_STORE).get(IDB_KEY);
    getReq.onsuccess = () => {
      db.close();
      resolve(getReq.result ?? null);
    };
    getReq.onerror = () => {
      db.close();
      reject(getReq.error);
    };
  });
}

// ---- Schema (mirrors crates/dledger-core/src/schema.rs + etherscan table) ----

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS currency (
    code TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES account(id),
    account_type TEXT NOT NULL CHECK(account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    allowed_currencies TEXT NOT NULL DEFAULT '[]',
    is_postable INTEGER NOT NULL DEFAULT 1,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_parent ON account(parent_id);
CREATE INDEX IF NOT EXISTS idx_account_type ON account(account_type);

CREATE TABLE IF NOT EXISTS account_closure (
    ancestor_id TEXT NOT NULL REFERENCES account(id),
    descendant_id TEXT NOT NULL REFERENCES account(id),
    depth INTEGER NOT NULL,
    PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX IF NOT EXISTS idx_account_closure_desc ON account_closure(descendant_id);

CREATE TABLE IF NOT EXISTS journal_entry (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'pending', 'voided')),
    source TEXT NOT NULL DEFAULT 'manual',
    voided_by TEXT REFERENCES journal_entry(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_date ON journal_entry(date);
CREATE INDEX IF NOT EXISTS idx_journal_entry_status ON journal_entry(status);

CREATE TABLE IF NOT EXISTS line_item (
    id TEXT PRIMARY KEY NOT NULL,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL REFERENCES currency(code),
    amount TEXT NOT NULL,
    lot_id TEXT REFERENCES lot(id)
);
CREATE INDEX IF NOT EXISTS idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_line_item_account ON line_item(account_id);
CREATE INDEX IF NOT EXISTS idx_line_item_currency ON line_item(currency);

CREATE TABLE IF NOT EXISTS lot (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL REFERENCES currency(code),
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL REFERENCES currency(code),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lot_account_currency ON lot(account_id, currency);
CREATE INDEX IF NOT EXISTS idx_lot_open ON lot(account_id, currency, is_closed, acquired_date);

CREATE TABLE IF NOT EXISTS lot_disposal (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lot(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    quantity TEXT NOT NULL,
    proceeds_per_unit TEXT NOT NULL,
    proceeds_currency TEXT NOT NULL REFERENCES currency(code),
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_date ON lot_disposal(disposal_date);

CREATE TABLE IF NOT EXISTS exchange_rate (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL REFERENCES currency(code),
    to_currency TEXT NOT NULL REFERENCES currency(code),
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

CREATE TABLE IF NOT EXISTS balance_assertion (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL REFERENCES currency(code),
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT
);
CREATE INDEX IF NOT EXISTS idx_balance_assertion_account ON balance_assertion(account_id);

CREATE TABLE IF NOT EXISTS journal_entry_metadata (
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (journal_entry_id, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS etherscan_account (
    address TEXT NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 1,
    label TEXT NOT NULL,
    PRIMARY KEY (address, chain_id)
);

CREATE TABLE IF NOT EXISTS raw_transaction (
    source TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS currency_rate_source (
    currency TEXT PRIMARY KEY NOT NULL,
    rate_source TEXT,
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS budget (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exchange_account (
    id TEXT PRIMARY KEY NOT NULL,
    exchange TEXT NOT NULL,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    linked_etherscan_account_id TEXT,
    passphrase TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL
);
`;

// ---- Row type helpers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function mapCurrency(row: Row): Currency {
  return {
    code: row.code,
    name: row.name,
    decimal_places: row.decimal_places,
    is_base: row.is_base !== 0,
    is_hidden: row.is_hidden !== 0,
  };
}

function mapAccount(row: Row): Account {
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    account_type: row.account_type as AccountType,
    name: row.name,
    full_name: row.full_name,
    allowed_currencies: JSON.parse(row.allowed_currencies || "[]"),
    is_postable: row.is_postable !== 0,
    is_archived: row.is_archived !== 0,
    created_at: row.created_at,
  };
}

function mapJournalEntry(row: Row): JournalEntry {
  return {
    id: row.id,
    date: row.date,
    description: row.description,
    status: row.status as JournalEntryStatus,
    source: row.source,
    voided_by: row.voided_by ?? null,
    created_at: row.created_at,
  };
}

function mapLineItem(row: Row): LineItem {
  return {
    id: row.id,
    journal_entry_id: row.journal_entry_id,
    account_id: row.account_id,
    currency: row.currency,
    amount: row.amount,
    lot_id: row.lot_id ?? null,
  };
}

function mapExchangeRate(row: Row): ExchangeRate {
  return {
    id: row.id,
    date: row.date,
    from_currency: row.from_currency,
    to_currency: row.to_currency,
    rate: row.rate,
    source: row.source,
  };
}

// ---- Source priority helper ----

function sourcePriority(source: string): number {
  switch (source) {
    case "manual":
      return 3;
    case "ledger-file":
    case "transaction":
      return 2;
    default:
      return 1;
  }
}

// ---- set_by priority for currency_rate_source ----

function setByPriority(setBy: string): number {
  if (setBy === "user") return 3;
  if (setBy.startsWith("handler:")) return 2;
  return 1; // "auto"
}

// ---- Free helpers ----

function mapToBalances(map: Map<string, Decimal>): CurrencyBalance[] {
  return Array.from(map.entries()).map(([currency, amount]) => ({
    currency,
    amount: amount.toString(),
  }));
}

function subtractBalances(
  end: CurrencyBalance[],
  start: CurrencyBalance[],
): CurrencyBalance[] {
  const startMap = new Map<string, Decimal>();
  for (const b of start) startMap.set(b.currency, new Decimal(b.amount));

  const result = new Map<string, Decimal>();
  for (const b of end) {
    const startAmount = startMap.get(b.currency) ?? new Decimal(0);
    const diff = new Decimal(b.amount).minus(startAmount);
    if (!diff.isZero()) result.set(b.currency, diff);
  }
  for (const b of start) {
    if (!result.has(b.currency) && !end.some((e) => e.currency === b.currency)) {
      const diff = new Decimal(b.amount).neg();
      if (!diff.isZero()) result.set(b.currency, diff);
    }
  }
  return mapToBalances(result);
}

// ---- SqlJsBackend ----

export class SqlJsBackend implements Backend {
  private db: Database;
  private sql: SqlJsStatic;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private inTransaction = false;
  private disposed = false;

  private constructor(db: Database, sql: SqlJsStatic) {
    this.db = db;
    this.sql = sql;
  }

  static async createInMemory(): Promise<SqlJsBackend> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const backend = new SqlJsBackend(db, SQL);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
    db.exec("CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value)");
    // Reconciliation tables (v9)
    db.exec("ALTER TABLE line_item ADD COLUMN is_reconciled INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS reconciliation (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, statement_date TEXT NOT NULL,
      statement_balance TEXT NOT NULL, currency TEXT NOT NULL, reconciled_at TEXT NOT NULL,
      line_item_count INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_line_item (
      reconciliation_id TEXT NOT NULL, line_item_id TEXT NOT NULL,
      PRIMARY KEY (reconciliation_id, line_item_id)
    )`);
    // Recurring templates (v10)
    db.exec(`CREATE TABLE IF NOT EXISTS recurring_template (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
      interval_val INTEGER NOT NULL DEFAULT 1, next_date TEXT NOT NULL, end_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, line_items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    )`);
    // Token address mapping (v12)
    db.exec(`CREATE TABLE IF NOT EXISTS currency_token_address (
      currency TEXT NOT NULL, chain TEXT NOT NULL, contract_address TEXT NOT NULL,
      PRIMARY KEY (currency, chain)
    )`);
    // Account metadata (v14)
    db.exec(`CREATE TABLE IF NOT EXISTS account_metadata (
      account_id TEXT NOT NULL REFERENCES account(id),
      key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (account_id, key)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value)");
    db.exec("INSERT INTO schema_version (version) VALUES (14)");
    return backend;
  }

  static async create(): Promise<SqlJsBackend> {
    const SQL = await initSqlJs({
      locateFile: () => `/sql-wasm.wasm`,
    });
    const saved = await loadFromIndexedDB();
    const db = saved ? new SQL.Database(saved) : new SQL.Database();
    const backend = new SqlJsBackend(db, SQL);
    db.exec("PRAGMA foreign_keys=ON");
    if (!saved) {
      db.exec(SCHEMA_SQL);
      db.exec("CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value)");
      db.exec(`CREATE TABLE IF NOT EXISTS currency_token_address (
        currency TEXT NOT NULL, chain TEXT NOT NULL, contract_address TEXT NOT NULL,
        PRIMARY KEY (currency, chain)
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS account_metadata (
        account_id TEXT NOT NULL REFERENCES account(id),
        key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (account_id, key)
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value)");
      db.exec("INSERT INTO schema_version (version) VALUES (14)");
    } else {
      // Handle partially-initialized DB from previous failed session
      const versionRows = db.exec("SELECT version FROM schema_version");
      if (versionRows.length === 0 || versionRows[0].values.length === 0) {
        db.exec("INSERT INTO schema_version (version) VALUES (5)");
      } else {
        const currentVersion = versionRows[0].values[0][0] as number;
        if (currentVersion < 2) {
          db.exec("DELETE FROM exchange_rate WHERE rowid NOT IN (SELECT MAX(rowid) FROM exchange_rate GROUP BY date, from_currency, to_currency)");
          db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency)");
        }
        if (currentVersion < 3) {
          db.exec("CREATE TABLE IF NOT EXISTS currency_handler (currency TEXT PRIMARY KEY NOT NULL, handler TEXT NOT NULL)");
        }
        if (currentVersion < 4) {
          // Migrate v3 → v4: currency_handler → currency_rate_source
          db.exec("CREATE TABLE IF NOT EXISTS currency_rate_source (currency TEXT PRIMARY KEY NOT NULL, rate_source TEXT, set_by TEXT NOT NULL DEFAULT 'auto', updated_at TEXT NOT NULL DEFAULT '')");
          const today = new Date().toISOString().slice(0, 10);
          // Migrate existing currency_handler rows: handler-owned tokens → rate_source = "none"
          try {
            const handlerRows = db.exec("SELECT currency, handler FROM currency_handler");
            if (handlerRows.length > 0 && handlerRows[0].values.length > 0) {
              const insertStmt = db.prepare("INSERT OR IGNORE INTO currency_rate_source (currency, rate_source, set_by, updated_at) VALUES (?, ?, ?, ?)");
              for (const row of handlerRows[0].values) {
                const currency = row[0] as string;
                const handler = row[1] as string;
                insertStmt.bind([currency, "none", `handler:${handler}`, today]);
                insertStmt.step();
                insertStmt.reset();
              }
              insertStmt.free();
            }
          } catch {
            // currency_handler might not exist
          }
          // Migrate rateSources from localStorage: preferred entries → set_by = "user"
          try {
            const raw = localStorage.getItem("dledger-settings");
            if (raw) {
              const parsed = JSON.parse(raw);
              const rateSources = parsed.rateSources as Record<string, { available: string[]; preferred: string }> | undefined;
              if (rateSources) {
                const insertStmt = db.prepare("INSERT OR IGNORE INTO currency_rate_source (currency, rate_source, set_by, updated_at) VALUES (?, ?, ?, ?)");
                for (const [currency, info] of Object.entries(rateSources)) {
                  if (info.preferred) {
                    insertStmt.bind([currency, info.preferred, "user", today]);
                    insertStmt.step();
                    insertStmt.reset();
                  }
                }
                insertStmt.free();
              }
            }
          } catch {
            // localStorage may not be available
          }
          // Drop old table
          try {
            db.exec("DROP TABLE IF EXISTS currency_handler");
          } catch {
            // ignore
          }
        }
        if (currentVersion < 5) {
          // Migrate v4 → v5: add is_spam column to currency table
          db.exec("ALTER TABLE currency ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0");
          // Migrate existing hiddenCurrencies from localStorage → set is_spam = 1
          try {
            const raw = localStorage.getItem("dledger-settings");
            if (raw) {
              const parsed = JSON.parse(raw);
              const hidden = parsed.hiddenCurrencies as string[] | undefined;
              if (hidden && hidden.length > 0) {
                const updateStmt = db.prepare("UPDATE currency SET is_spam = 1 WHERE code = ?");
                for (const code of hidden) {
                  updateStmt.bind([code]);
                  updateStmt.step();
                  updateStmt.reset();
                }
                updateStmt.free();
              }
            }
          } catch {
            // localStorage may not be available
          }
        }
        if (currentVersion < 6) {
          // Migrate v5 → v6: rename is_spam → is_hidden
          db.exec("ALTER TABLE currency RENAME COLUMN is_spam TO is_hidden");
        }
        if (currentVersion < 7) {
          // Migrate v6 → v7: add budget table
          db.exec(`CREATE TABLE IF NOT EXISTS budget (
            id TEXT PRIMARY KEY,
            account_pattern TEXT NOT NULL,
            period_type TEXT NOT NULL DEFAULT 'monthly',
            amount TEXT NOT NULL,
            currency TEXT NOT NULL,
            start_date TEXT,
            end_date TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`);
        }
        if (currentVersion < 8) {
          // Migrate v7 → v8: add metadata index for handler/action queries
          db.exec("CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value)");
        }
        if (currentVersion < 9) {
          // Migrate v8 → v9: reconciliation support
          db.exec("ALTER TABLE line_item ADD COLUMN is_reconciled INTEGER NOT NULL DEFAULT 0");
          db.exec(`CREATE TABLE IF NOT EXISTS reconciliation (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, statement_date TEXT NOT NULL,
            statement_balance TEXT NOT NULL, currency TEXT NOT NULL, reconciled_at TEXT NOT NULL,
            line_item_count INTEGER NOT NULL DEFAULT 0
          )`);
          db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_line_item (
            reconciliation_id TEXT NOT NULL, line_item_id TEXT NOT NULL,
            PRIMARY KEY (reconciliation_id, line_item_id)
          )`);
        }
        if (currentVersion < 10) {
          // Migrate v9 → v10: recurring templates
          db.exec(`CREATE TABLE IF NOT EXISTS recurring_template (
            id TEXT PRIMARY KEY, description TEXT NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
            interval_val INTEGER NOT NULL DEFAULT 1, next_date TEXT NOT NULL, end_date TEXT,
            is_active INTEGER NOT NULL DEFAULT 1, line_items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
          )`);
        }
        if (currentVersion < 11) {
          // Migrate v10 → v11: exchange_account table for CEX integration
          db.exec(`CREATE TABLE IF NOT EXISTS exchange_account (
            id TEXT PRIMARY KEY NOT NULL, exchange TEXT NOT NULL, label TEXT NOT NULL,
            api_key TEXT NOT NULL, api_secret TEXT NOT NULL,
            linked_etherscan_account_id TEXT, last_sync TEXT, created_at TEXT NOT NULL
          )`);
        }
        if (currentVersion < 12) {
          db.exec(`CREATE TABLE IF NOT EXISTS currency_token_address (
            currency TEXT NOT NULL, chain TEXT NOT NULL, contract_address TEXT NOT NULL,
            PRIMARY KEY (currency, chain)
          )`);
        }
        if (currentVersion < 13) {
          db.exec("ALTER TABLE exchange_account ADD COLUMN passphrase TEXT");
        }
        if (currentVersion < 14) {
          db.exec(`CREATE TABLE IF NOT EXISTS account_metadata (
            account_id TEXT NOT NULL REFERENCES account(id),
            key TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (account_id, key)
          )`);
          db.exec("CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value)");
        }
        if (currentVersion < 14) {
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (14)");
        }
      }
    }
    // Ensure raw_transaction table exists (added post-v2)
    try {
      db.exec("CREATE TABLE IF NOT EXISTS raw_transaction (source TEXT PRIMARY KEY, data TEXT NOT NULL)");
    } catch {
      // ignore if already exists
    }
    return backend;
  }

  // ---- Internal query helpers ----

  private run(sql: string, params: unknown[] = []): void {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params as (string | number | null | Uint8Array)[]);
    try {
      stmt.step();
    } finally {
      stmt.free();
    }
  }

  private query<T>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => T,
  ): T[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params as (string | number | null | Uint8Array)[]);
    const results: T[] = [];
    try {
      while (stmt.step()) {
        results.push(mapRow(stmt.getAsObject()));
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  private queryOne<T>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => T,
  ): T | null {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params as (string | number | null | Uint8Array)[]);
    let result: T | null = null;
    try {
      if (stmt.step()) {
        result = mapRow(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return result;
  }

  private scheduleSave(): void {
    if (this.disposed) return;
    if (this.inTransaction) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = this.db.export();
      saveToIndexedDB(data).catch(console.error);
    }, 500);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      if (this.inTransaction) {
        try { this.db.exec("ROLLBACK"); } catch (_) { /* ignore */ }
        this.inTransaction = false;
      }
      const data = this.db.export();
      saveToIndexedDB(data).catch(() => {});
      this.db.close();
    } catch (_) {
      // Runs during page teardown — must not throw
    }
  }

  beginTransaction(): void {
    if (this.inTransaction) return;
    this.db.exec("BEGIN");
    this.inTransaction = true;
  }

  commitTransaction(): void {
    if (!this.inTransaction) return;
    try {
      this.db.exec("COMMIT");
    } catch (_) {
      // Transaction may have already been committed or auto-rolled-back
    }
    this.inTransaction = false;
    this.scheduleSave();
  }

  rollbackTransaction(): void {
    if (!this.inTransaction) return;
    try {
      this.db.exec("ROLLBACK");
    } catch (_) {
      // Transaction may have been auto-rolled-back by SQLite on error
    }
    this.inTransaction = false;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private audit(
    action: string,
    entityType: string,
    entityId: string,
    details: string,
  ): void {
    this.run(
      "INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv7(), this.today(), action, entityType, entityId, details],
    );
  }

  // ---- Internal data access ----

  private getCurrencyByCode(code: string): Currency | null {
    return this.queryOne(
      "SELECT code, name, decimal_places, is_base, is_hidden FROM currency WHERE code = ?",
      [code],
      mapCurrency,
    );
  }

  private getAccountByFullName(fullName: string): Account | null {
    return this.queryOne(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account WHERE full_name = ?",
      [fullName],
      mapAccount,
    );
  }

  private getAccountById(id: string): Account | null {
    return this.queryOne(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account WHERE id = ?",
      [id],
      mapAccount,
    );
  }

  private insertClosureEntries(
    accountId: string,
    parentId: string | null,
  ): void {
    this.run(
      "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)",
      [accountId, accountId],
    );
    if (parentId) {
      this.run(
        "INSERT INTO account_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM account_closure WHERE descendant_id = ?",
        [accountId, parentId],
      );
    }
  }

  private getAccountSubtreeIds(id: string): string[] {
    return this.query(
      "SELECT descendant_id FROM account_closure WHERE ancestor_id = ? ORDER BY depth",
      [id],
      (row) => row.descendant_id as string,
    );
  }

  private fetchLineItemsForEntry(entryId: string): LineItem[] {
    return this.query(
      "SELECT id, journal_entry_id, account_id, currency, amount, lot_id FROM line_item WHERE journal_entry_id = ?",
      [entryId],
      mapLineItem,
    );
  }

  private sumLineItems(
    accountIds: string[],
    beforeDate?: string,
  ): CurrencyBalance[] {
    if (accountIds.length === 0) return [];

    const placeholders = accountIds.map(() => "?").join(", ");
    const params: unknown[] = [...accountIds];

    let sql = `SELECT li.currency, li.amount FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id WHERE li.account_id IN (${placeholders})`;
    if (beforeDate) {
      sql += " AND je.date < ?";
      params.push(beforeDate);
    }

    const rows = this.query(sql, params, (row) => ({
      currency: row.currency as string,
      amount: row.amount as string,
    }));

    const totals = new Map<string, Decimal>();
    for (const row of rows) {
      const current = totals.get(row.currency) ?? new Decimal(0);
      totals.set(row.currency, current.plus(new Decimal(row.amount)));
    }

    const balances: CurrencyBalance[] = [];
    for (const [currency, amount] of totals) {
      balances.push({ currency, amount: amount.toString() });
    }
    balances.sort((a, b) => a.currency.localeCompare(b.currency));
    return balances;
  }

  /**
   * Single-query batch: returns balances for ALL accounts at once.
   * Result map is keyed by account_id → CurrencyBalance[].
   */
  private sumAllLineItemsByAccount(
    beforeDate?: string,
  ): Map<string, CurrencyBalance[]> {
    const params: unknown[] = [];
    let sql =
      "SELECT li.account_id, li.currency, li.amount FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id";
    if (beforeDate) {
      sql += " WHERE je.date < ?";
      params.push(beforeDate);
    }

    // Accumulate per (account_id, currency)
    const accum = new Map<string, Map<string, Decimal>>();
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params as (string | number | null | Uint8Array)[]);
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const accountId = row.account_id as string;
        const currency = row.currency as string;
        const amount = new Decimal(row.amount as string);

        let currencies = accum.get(accountId);
        if (!currencies) {
          currencies = new Map<string, Decimal>();
          accum.set(accountId, currencies);
        }
        const current = currencies.get(currency) ?? new Decimal(0);
        currencies.set(currency, current.plus(amount));
      }
    } finally {
      stmt.free();
    }

    // Convert to CurrencyBalance[]
    const result = new Map<string, CurrencyBalance[]>();
    for (const [accountId, currencies] of accum) {
      const balances: CurrencyBalance[] = [];
      for (const [currency, amount] of currencies) {
        balances.push({ currency, amount: amount.toString() });
      }
      balances.sort((a, b) => a.currency.localeCompare(b.currency));
      result.set(accountId, balances);
    }
    return result;
  }

  // ---- Validation (port of validation.rs) ----

  private validateJournalEntry(items: LineItem[]): void {
    if (items.length === 0) {
      throw new Error("journal entry has no line items");
    }

    const sums = new Map<string, Decimal>();
    const seenIds = new Set<string>();

    for (const item of items) {
      if (seenIds.has(item.id)) {
        throw new Error(`duplicate line item ID ${item.id}`);
      }
      seenIds.add(item.id);

      const amount = new Decimal(item.amount);
      if (amount.isZero()) {
        throw new Error("line item amount cannot be zero");
      }

      const current = sums.get(item.currency) ?? new Decimal(0);
      sums.set(item.currency, current.plus(amount));
    }

    for (const [currency, sum] of sums) {
      if (!sum.isZero()) {
        throw new Error(
          `journal entry does not balance for currency ${currency}: sum is ${sum.toString()}`,
        );
      }
    }

    // Batch: check all currencies in one query
    const currencyCodes = [...new Set(items.map((i) => i.currency))];
    if (currencyCodes.length > 0) {
      const ph = currencyCodes.map(() => "?").join(", ");
      const found = new Set(
        this.query(
          `SELECT code FROM currency WHERE code IN (${ph})`,
          currencyCodes,
          (row) => row.code as string,
        ),
      );
      for (const code of currencyCodes) {
        if (!found.has(code)) {
          throw new Error(`currency ${code} does not exist`);
        }
      }
    }

    // Batch: check all accounts in one query
    const accountIdList = [...new Set(items.map((i) => i.account_id))];
    if (accountIdList.length > 0) {
      const ph = accountIdList.map(() => "?").join(", ");
      const accountMap = new Map<string, Account>();
      const accounts = this.query(
        `SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account WHERE id IN (${ph})`,
        accountIdList,
        mapAccount,
      );
      for (const a of accounts) accountMap.set(a.id, a);

      for (const accountId of accountIdList) {
        const account = accountMap.get(accountId);
        if (!account) throw new Error(`account ${accountId} does not exist`);
        if (!account.is_postable)
          throw new Error(`account ${accountId} is not postable`);
        if (account.is_archived)
          throw new Error(`account ${accountId} is archived`);
        if (account.allowed_currencies.length > 0) {
          for (const item of items) {
            if (
              item.account_id === accountId &&
              !account.allowed_currencies.includes(item.currency)
            ) {
              throw new Error(
                `account ${accountId} does not allow currency ${item.currency}`,
              );
            }
          }
        }
      }
    }
  }

  // ---- Backend: Currencies ----

  async listCurrencies(): Promise<Currency[]> {
    return this.query(
      "SELECT code, name, decimal_places, is_base, is_hidden FROM currency ORDER BY code",
      [],
      mapCurrency,
    );
  }

  async createCurrency(currency: Currency): Promise<void> {
    try {
      this.run(
        "INSERT INTO currency (code, name, decimal_places, is_base, is_hidden) VALUES (?, ?, ?, ?, ?)",
        [
          currency.code,
          currency.name,
          currency.decimal_places,
          currency.is_base ? 1 : 0,
          currency.is_hidden ? 1 : 0,
        ],
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        throw new Error(`currency ${currency.code} already exists`);
      }
      throw e;
    }
    this.audit("create", "currency", "", currency.code);
    this.scheduleSave();
  }

  async setCurrencyHidden(code: string, isHidden: boolean): Promise<void> {
    this.run("UPDATE currency SET is_hidden = ? WHERE code = ?", [isHidden ? 1 : 0, code]);
    this.scheduleSave();
  }

  async listHiddenCurrencies(): Promise<string[]> {
    return this.query(
      "SELECT code FROM currency WHERE is_hidden = 1 ORDER BY code",
      [],
      (row) => row.code as string,
    );
  }

  // ---- Backend: Currency token addresses ----

  async setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void> {
    this.run(
      "INSERT OR IGNORE INTO currency_token_address (currency, chain, contract_address) VALUES (?, ?, ?)",
      [currency, chain, contractAddress],
    );
    this.scheduleSave();
  }

  async getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>> {
    return this.query(
      "SELECT currency, chain, contract_address FROM currency_token_address ORDER BY currency",
      [],
      (row) => ({
        currency: row.currency as string,
        chain: row.chain as string,
        contract_address: row.contract_address as string,
      }),
    );
  }

  async getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null> {
    return this.queryOne(
      "SELECT chain, contract_address FROM currency_token_address WHERE currency = ? LIMIT 1",
      [currency],
      (row) => ({
        chain: row.chain as string,
        contract_address: row.contract_address as string,
      }),
    );
  }

  // ---- Backend: Accounts ----

  async listAccounts(): Promise<Account[]> {
    return this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.getAccountById(id);
  }

  async createAccount(account: Account): Promise<void> {
    try {
      this.run(
        "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          account.id,
          account.parent_id,
          account.account_type,
          account.name,
          account.full_name,
          JSON.stringify(account.allowed_currencies),
          account.is_postable ? 1 : 0,
          account.is_archived ? 1 : 0,
          account.created_at,
        ],
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        throw new Error(`account ${account.full_name} already exists`);
      }
      throw e;
    }
    this.insertClosureEntries(account.id, account.parent_id);
    this.audit("create", "account", account.id, account.full_name);
    this.scheduleSave();
  }

  async archiveAccount(id: string): Promise<void> {
    const account = this.getAccountById(id);
    if (!account) throw new Error(`account ${id} not found`);
    this.run("UPDATE account SET is_archived = 1 WHERE id = ?", [id]);
    this.audit("archive", "account", id, account.full_name);
    this.scheduleSave();
  }

  // ---- Backend: Journal entries ----

  async postJournalEntry(
    entry: JournalEntry,
    items: LineItem[],
  ): Promise<void> {
    this.validateJournalEntry(items);
    this.run(
      "INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        entry.id,
        entry.date,
        entry.description,
        entry.status,
        entry.source,
        entry.voided_by,
        entry.created_at,
      ],
    );
    for (const item of items) {
      this.run(
        "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?)",
        [
          item.id,
          item.journal_entry_id,
          item.account_id,
          item.currency,
          item.amount,
          item.lot_id,
        ],
      );
    }
    this.audit("post", "journal_entry", entry.id, entry.description);
    this.scheduleSave();
  }

  async voidJournalEntry(id: string): Promise<JournalEntry> {
    const original = this.queryOne(
      "SELECT id, date, description, status, source, voided_by, created_at FROM journal_entry WHERE id = ?",
      [id],
      mapJournalEntry,
    );
    if (!original) throw new Error(`journal entry ${id} not found`);
    if (original.status === "voided")
      throw new Error(`journal entry ${id} is already voided`);

    const items = this.fetchLineItemsForEntry(id);
    const reversalId = uuidv7();
    const today = this.today();

    const reversal: JournalEntry = {
      id: reversalId,
      date: today,
      description: `Reversal of: ${original.description}`,
      status: "confirmed",
      source: "system:void",
      voided_by: null,
      created_at: today,
    };

    this.run(
      "INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        reversal.id,
        reversal.date,
        reversal.description,
        reversal.status,
        reversal.source,
        null,
        reversal.created_at,
      ],
    );

    for (const item of items) {
      const negAmount = new Decimal(item.amount).neg().toString();
      this.run(
        "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?)",
        [uuidv7(), reversalId, item.account_id, item.currency, negAmount, null],
      );
    }

    this.run(
      "UPDATE journal_entry SET status = 'voided', voided_by = ? WHERE id = ?",
      [reversalId, id],
    );

    this.audit(
      "void",
      "journal_entry",
      id,
      `reversed by ${reversalId}`,
    );
    this.scheduleSave();
    return reversal;
  }

  async getJournalEntry(
    id: string,
  ): Promise<[JournalEntry, LineItem[]] | null> {
    const entry = this.queryOne(
      "SELECT id, date, description, status, source, voided_by, created_at FROM journal_entry WHERE id = ?",
      [id],
      mapJournalEntry,
    );
    if (!entry) return null;
    return [entry, this.fetchLineItemsForEntry(id)];
  }

  async queryJournalEntries(
    filter: TransactionFilter,
  ): Promise<[JournalEntry, LineItem[]][]> {
    let sql =
      "SELECT DISTINCT je.id, je.date, je.description, je.status, je.source, je.voided_by, je.created_at FROM journal_entry je";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.account_id) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      conditions.push("li.account_id = ?");
      params.push(filter.account_id);
    }
    if (filter.from_date) {
      conditions.push("je.date >= ?");
      params.push(filter.from_date);
    }
    if (filter.to_date) {
      conditions.push("je.date <= ?");
      params.push(filter.to_date);
    }
    if (filter.status) {
      conditions.push("je.status = ?");
      params.push(filter.status);
    }
    if (filter.source) {
      conditions.push("je.source = ?");
      params.push(filter.source);
    }
    if (filter.description_search) {
      conditions.push("je.description LIKE ?");
      params.push(`%${filter.description_search}%`);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY je.date DESC, je.created_at DESC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    if (filter.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(filter.offset);
    }

    const entries = this.query(sql, params, mapJournalEntry);
    if (entries.length === 0) return [];

    // Batch: one query for ALL line items instead of N+1
    const entryIds = entries.map((e) => e.id);
    const ph = entryIds.map(() => "?").join(", ");
    const allItems = this.query(
      `SELECT id, journal_entry_id, account_id, currency, amount, lot_id
       FROM line_item WHERE journal_entry_id IN (${ph})`,
      entryIds,
      mapLineItem,
    );
    const itemsByEntry = new Map<string, LineItem[]>();
    for (const item of allItems) {
      let list = itemsByEntry.get(item.journal_entry_id);
      if (!list) {
        list = [];
        itemsByEntry.set(item.journal_entry_id, list);
      }
      list.push(item);
    }
    return entries.map((e) => [e, itemsByEntry.get(e.id) ?? []] as [JournalEntry, LineItem[]]);
  }

  async countJournalEntries(
    filter: TransactionFilter,
  ): Promise<number> {
    let sql =
      "SELECT COUNT(DISTINCT je.id) as cnt FROM journal_entry je";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.account_id) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      conditions.push("li.account_id = ?");
      params.push(filter.account_id);
    }
    if (filter.from_date) {
      conditions.push("je.date >= ?");
      params.push(filter.from_date);
    }
    if (filter.to_date) {
      conditions.push("je.date <= ?");
      params.push(filter.to_date);
    }
    if (filter.status) {
      conditions.push("je.status = ?");
      params.push(filter.status);
    }
    if (filter.source) {
      conditions.push("je.source = ?");
      params.push(filter.source);
    }
    if (filter.description_search) {
      conditions.push("je.description LIKE ?");
      params.push(`%${filter.description_search}%`);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    const result = this.queryOne(sql, params, (row) => row.cnt as number);
    return result ?? 0;
  }

  // ---- Backend: Balances ----

  async getAccountBalance(
    accountId: string,
    asOf?: string,
  ): Promise<CurrencyBalance[]> {
    return this.sumLineItems([accountId], asOf);
  }

  async getAccountBalanceWithChildren(
    accountId: string,
    asOf?: string,
  ): Promise<CurrencyBalance[]> {
    const subtreeIds = this.getAccountSubtreeIds(accountId);
    if (subtreeIds.length === 0) return [];
    return this.sumLineItems(subtreeIds, asOf);
  }

  // ---- Backend: Reports (port of reports.rs) ----

  async trialBalance(asOf: string): Promise<TrialBalance> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const allBalances = this.sumAllLineItemsByAccount(asOf);
    const lines: TrialBalanceLine[] = [];
    const debitTotals = new Map<string, Decimal>();
    const creditTotals = new Map<string, Decimal>();

    for (const account of accounts) {
      if (!account.is_postable) continue;
      const balances = allBalances.get(account.id) ?? [];
      if (balances.length === 0) continue;

      for (const bal of balances) {
        const amount = new Decimal(bal.amount);
        if (amount.gt(0)) {
          const cur = debitTotals.get(bal.currency) ?? new Decimal(0);
          debitTotals.set(bal.currency, cur.plus(amount));
        } else if (amount.lt(0)) {
          const cur = creditTotals.get(bal.currency) ?? new Decimal(0);
          creditTotals.set(bal.currency, cur.plus(amount.abs()));
        }
      }

      lines.push({
        account_id: account.id,
        account_name: account.full_name,
        account_type: account.account_type,
        balances,
      });
    }

    return {
      as_of: asOf,
      lines,
      total_debits: mapToBalances(debitTotals),
      total_credits: mapToBalances(creditTotals),
    };
  }

  /**
   * Single-pass dual-date scan: returns balances for ALL accounts at two dates.
   * Scans line_items once up to the later date, snapshots at the earlier boundary.
   */
  private sumAllLineItemsByAccountDual(
    date1: string,
    date2: string,
  ): [Map<string, CurrencyBalance[]>, Map<string, CurrencyBalance[]>] {
    const [earlier, later] = date1 < date2 ? [date1, date2] : [date2, date1];

    const sql =
      "SELECT li.account_id, li.currency, li.amount, je.date FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id WHERE je.date < ? ORDER BY je.date ASC";
    const stmt = this.db.prepare(sql);
    stmt.bind([later]);

    const running = new Map<string, Map<string, Decimal>>();
    let snapshotAtEarlier: Map<string, Map<string, Decimal>> | null = null;
    let passedEarlier = false;

    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const rowDate = row.date as string;

        if (!passedEarlier && rowDate >= earlier) {
          // Snapshot running totals at the earlier boundary
          snapshotAtEarlier = new Map();
          for (const [accId, currencies] of running) {
            snapshotAtEarlier.set(accId, new Map(currencies));
          }
          passedEarlier = true;
        }

        const accountId = row.account_id as string;
        const currency = row.currency as string;
        const amount = new Decimal(row.amount as string);

        let currencies = running.get(accountId);
        if (!currencies) {
          currencies = new Map<string, Decimal>();
          running.set(accountId, currencies);
        }
        const current = currencies.get(currency) ?? new Decimal(0);
        currencies.set(currency, current.plus(amount));
      }
    } finally {
      stmt.free();
    }

    if (!passedEarlier) {
      // All rows were before the earlier date boundary
      snapshotAtEarlier = new Map();
      for (const [accId, currencies] of running) {
        snapshotAtEarlier.set(accId, new Map(currencies));
      }
    }

    const toBalanceMap = (accum: Map<string, Map<string, Decimal>>): Map<string, CurrencyBalance[]> => {
      const result = new Map<string, CurrencyBalance[]>();
      for (const [accountId, currencies] of accum) {
        const balances: CurrencyBalance[] = [];
        for (const [currency, amount] of currencies) {
          balances.push({ currency, amount: amount.toString() });
        }
        balances.sort((a, b) => a.currency.localeCompare(b.currency));
        result.set(accountId, balances);
      }
      return result;
    };

    const earlierResult = toBalanceMap(snapshotAtEarlier!);
    const laterResult = toBalanceMap(running);

    return date1 < date2 ? [earlierResult, laterResult] : [laterResult, earlierResult];
  }

  async incomeStatement(
    fromDate: string,
    toDate: string,
  ): Promise<IncomeStatement> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const [allBalancesStart, allBalancesEnd] = this.sumAllLineItemsByAccountDual(fromDate, toDate);
    const revenueLines: TrialBalanceLine[] = [];
    const expenseLines: TrialBalanceLine[] = [];
    const revenueTotals = new Map<string, Decimal>();
    const expenseTotals = new Map<string, Decimal>();

    for (const account of accounts) {
      if (!account.is_postable) continue;
      if (
        account.account_type !== "revenue" &&
        account.account_type !== "expense"
      )
        continue;

      const balEnd = allBalancesEnd.get(account.id) ?? [];
      const balStart = allBalancesStart.get(account.id) ?? [];
      const periodBalances = subtractBalances(balEnd, balStart);
      if (periodBalances.length === 0) continue;

      const line: TrialBalanceLine = {
        account_id: account.id,
        account_name: account.full_name,
        account_type: account.account_type,
        balances: periodBalances,
      };

      const totalsMap =
        account.account_type === "revenue" ? revenueTotals : expenseTotals;
      for (const bal of periodBalances) {
        const cur = totalsMap.get(bal.currency) ?? new Decimal(0);
        totalsMap.set(bal.currency, cur.plus(new Decimal(bal.amount)));
      }

      if (account.account_type === "revenue") revenueLines.push(line);
      else expenseLines.push(line);
    }

    const netIncomeMap = new Map<string, Decimal>();
    for (const [currency, amount] of revenueTotals) {
      const cur = netIncomeMap.get(currency) ?? new Decimal(0);
      netIncomeMap.set(currency, cur.minus(amount));
    }
    for (const [currency, amount] of expenseTotals) {
      const cur = netIncomeMap.get(currency) ?? new Decimal(0);
      netIncomeMap.set(currency, cur.minus(amount));
    }

    return {
      from_date: fromDate,
      to_date: toDate,
      revenue: {
        title: "Revenue",
        account_type: "revenue",
        lines: revenueLines,
        totals: mapToBalances(revenueTotals),
      },
      expenses: {
        title: "Expenses",
        account_type: "expense",
        lines: expenseLines,
        totals: mapToBalances(expenseTotals),
      },
      net_income: mapToBalances(netIncomeMap),
    };
  }

  async balanceSheet(asOf: string): Promise<BalanceSheet> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const allBalances = this.sumAllLineItemsByAccount(asOf);
    const assetLines: TrialBalanceLine[] = [];
    const liabilityLines: TrialBalanceLine[] = [];
    const equityLines: TrialBalanceLine[] = [];
    const assetTotals = new Map<string, Decimal>();
    const liabilityTotals = new Map<string, Decimal>();
    const equityTotals = new Map<string, Decimal>();

    for (const account of accounts) {
      if (!account.is_postable) continue;
      let totalsMap: Map<string, Decimal>;
      let linesList: TrialBalanceLine[];
      switch (account.account_type) {
        case "asset":
          totalsMap = assetTotals;
          linesList = assetLines;
          break;
        case "liability":
          totalsMap = liabilityTotals;
          linesList = liabilityLines;
          break;
        case "equity":
          totalsMap = equityTotals;
          linesList = equityLines;
          break;
        default:
          continue;
      }

      const balances = allBalances.get(account.id) ?? [];
      if (balances.length === 0) continue;

      for (const bal of balances) {
        const cur = totalsMap.get(bal.currency) ?? new Decimal(0);
        totalsMap.set(bal.currency, cur.plus(new Decimal(bal.amount)));
      }

      linesList.push({
        account_id: account.id,
        account_name: account.full_name,
        account_type: account.account_type,
        balances,
      });
    }

    return {
      as_of: asOf,
      assets: {
        title: "Assets",
        account_type: "asset",
        lines: assetLines,
        totals: mapToBalances(assetTotals),
      },
      liabilities: {
        title: "Liabilities",
        account_type: "liability",
        lines: liabilityLines,
        totals: mapToBalances(liabilityTotals),
      },
      equity: {
        title: "Equity",
        account_type: "equity",
        lines: equityLines,
        totals: mapToBalances(equityTotals),
      },
    };
  }

  async balanceSheetBatch(dates: string[]): Promise<Map<string, BalanceSheet>> {
    if (dates.length === 0) return new Map();

    // Single-pass: query accounts once, scan line_items once up to max date
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const sortedDates = [...dates].sort();
    const maxDate = sortedDates[sortedDates.length - 1];

    // Single scan of all line items up to the max date, ordered chronologically
    const sql =
      "SELECT li.account_id, li.currency, li.amount, je.date FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id WHERE je.date < ? ORDER BY je.date ASC";
    const stmt = this.db.prepare(sql);
    stmt.bind([maxDate]);

    // Running totals per (account_id, currency)
    const running = new Map<string, Map<string, Decimal>>();
    // Snapshots: date -> Map<accountId, Map<currency, Decimal>>
    const snapshots = new Map<string, Map<string, Map<string, Decimal>>>();

    // Track which sorted dates we've passed
    let dateIdx = 0;

    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const rowDate = row.date as string;

        // Snapshot at each date boundary we've passed
        while (dateIdx < sortedDates.length && rowDate >= sortedDates[dateIdx]) {
          // Deep-copy running totals for this snapshot
          const snap = new Map<string, Map<string, Decimal>>();
          for (const [accId, currencies] of running) {
            snap.set(accId, new Map(currencies));
          }
          snapshots.set(sortedDates[dateIdx], snap);
          dateIdx++;
        }

        // Accumulate this row into running totals
        const accountId = row.account_id as string;
        const currency = row.currency as string;
        const amount = new Decimal(row.amount as string);

        let currencies = running.get(accountId);
        if (!currencies) {
          currencies = new Map<string, Decimal>();
          running.set(accountId, currencies);
        }
        const current = currencies.get(currency) ?? new Decimal(0);
        currencies.set(currency, current.plus(amount));
      }
    } finally {
      stmt.free();
    }

    // Capture any remaining dates that are >= all rows
    while (dateIdx < sortedDates.length) {
      const snap = new Map<string, Map<string, Decimal>>();
      for (const [accId, currencies] of running) {
        snap.set(accId, new Map(currencies));
      }
      snapshots.set(sortedDates[dateIdx], snap);
      dateIdx++;
    }

    // Build BalanceSheet objects from snapshots
    const result = new Map<string, BalanceSheet>();
    for (const date of dates) {
      const allBalances = snapshots.get(date) ?? new Map();

      const assetLines: TrialBalanceLine[] = [];
      const liabilityLines: TrialBalanceLine[] = [];
      const equityLines: TrialBalanceLine[] = [];
      const assetTotals = new Map<string, Decimal>();
      const liabilityTotals = new Map<string, Decimal>();
      const equityTotals = new Map<string, Decimal>();

      for (const account of accounts) {
        if (!account.is_postable) continue;
        let totalsMap: Map<string, Decimal>;
        let linesList: TrialBalanceLine[];
        switch (account.account_type) {
          case "asset":
            totalsMap = assetTotals;
            linesList = assetLines;
            break;
          case "liability":
            totalsMap = liabilityTotals;
            linesList = liabilityLines;
            break;
          case "equity":
            totalsMap = equityTotals;
            linesList = equityLines;
            break;
          default:
            continue;
        }

        const currencyMap = allBalances.get(account.id);
        if (!currencyMap || currencyMap.size === 0) continue;

        const balances: CurrencyBalance[] = [];
        for (const [currency, amount] of currencyMap) {
          if (!amount.isZero()) {
            balances.push({ currency, amount: amount.toString() });
            const cur = totalsMap.get(currency) ?? new Decimal(0);
            totalsMap.set(currency, cur.plus(amount));
          }
        }
        balances.sort((a, b) => a.currency.localeCompare(b.currency));
        if (balances.length === 0) continue;

        linesList.push({
          account_id: account.id,
          account_name: account.full_name,
          account_type: account.account_type,
          balances,
        });
      }

      result.set(date, {
        as_of: date,
        assets: {
          title: "Assets",
          account_type: "asset",
          lines: assetLines,
          totals: mapToBalances(assetTotals),
        },
        liabilities: {
          title: "Liabilities",
          account_type: "liability",
          lines: liabilityLines,
          totals: mapToBalances(liabilityTotals),
        },
        equity: {
          title: "Equity",
          account_type: "equity",
          lines: equityLines,
          totals: mapToBalances(equityTotals),
        },
      });
    }

    return result;
  }

  async gainLossReport(
    fromDate: string,
    toDate: string,
  ): Promise<GainLossReport> {
    const disposals = this.query(
      "SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date FROM lot_disposal WHERE disposal_date >= ? AND disposal_date <= ? ORDER BY disposal_date ASC",
      [fromDate, toDate],
      (row) => ({
        lot_id: row.lot_id as string,
        quantity: row.quantity as string,
        proceeds_per_unit: row.proceeds_per_unit as string,
        realized_gain_loss: row.realized_gain_loss as string,
        disposal_date: row.disposal_date as string,
      }),
    );

    const lines: GainLossLine[] = [];
    let totalGainLoss = new Decimal(0);

    // Batch: fetch all lots at once
    const uniqueLotIds = [...new Set(disposals.map((d) => d.lot_id))];
    const lotMap = new Map<string, { currency: string; acquired_date: string; cost_basis_per_unit: string; source_handler: string | null }>();
    if (uniqueLotIds.length > 0) {
      const ph = uniqueLotIds.map(() => "?").join(", ");
      const lots = this.query(
        `SELECT id, currency, acquired_date, cost_basis_per_unit,
                (SELECT m.value FROM journal_entry_metadata m
                 WHERE m.journal_entry_id = lot.journal_entry_id AND m.key = 'handler') as source_handler
         FROM lot WHERE id IN (${ph})`,
        uniqueLotIds,
        (row) => ({
          id: row.id as string,
          currency: row.currency as string,
          acquired_date: row.acquired_date as string,
          cost_basis_per_unit: row.cost_basis_per_unit as string,
          source_handler: (row.source_handler as string) || null,
        }),
      );
      for (const lot of lots) {
        lotMap.set(lot.id, lot);
      }
    }

    for (const disposal of disposals) {
      const lot = lotMap.get(disposal.lot_id);
      if (!lot) continue;

      const qty = new Decimal(disposal.quantity);
      const costBasis = qty.times(new Decimal(lot.cost_basis_per_unit));
      const proceeds = qty.times(new Decimal(disposal.proceeds_per_unit));

      lines.push({
        lot_id: disposal.lot_id,
        currency: lot.currency,
        acquired_date: lot.acquired_date,
        disposed_date: disposal.disposal_date,
        quantity: disposal.quantity,
        cost_basis: costBasis.toString(),
        proceeds: proceeds.toString(),
        gain_loss: disposal.realized_gain_loss,
        source_handler: lot.source_handler,
      });

      totalGainLoss = totalGainLoss.plus(
        new Decimal(disposal.realized_gain_loss),
      );
    }

    return {
      from_date: fromDate,
      to_date: toDate,
      lines,
      total_gain_loss: totalGainLoss.toString(),
    };
  }

  async listOpenLots(): Promise<OpenLot[]> {
    return this.query(
      `SELECT l.id, l.account_id, a.full_name as account_name, l.currency,
              l.acquired_date, l.remaining_quantity, l.cost_basis_per_unit, l.cost_basis_currency,
              (SELECT m.value FROM journal_entry_metadata m
               WHERE m.journal_entry_id = l.journal_entry_id AND m.key = 'handler') as source_handler
       FROM lot l
       JOIN account a ON a.id = l.account_id
       WHERE l.is_closed = 0 AND CAST(l.remaining_quantity AS REAL) > 0
       ORDER BY l.currency, l.acquired_date`,
      [],
      (row) => ({
        id: row.id as string,
        account_id: row.account_id as string,
        account_name: row.account_name as string,
        currency: row.currency as string,
        acquired_date: row.acquired_date as string,
        remaining_quantity: row.remaining_quantity as string,
        cost_basis_per_unit: row.cost_basis_per_unit as string,
        cost_basis_currency: row.cost_basis_currency as string,
        source_handler: (row.source_handler as string) || null,
      }),
    );
  }

  // ---- Backend: Budgets ----

  async createBudget(budget: Budget): Promise<void> {
    this.run(
      `INSERT INTO budget (id, account_pattern, period_type, amount, currency, start_date, end_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [budget.id, budget.account_pattern, budget.period_type, budget.amount, budget.currency, budget.start_date, budget.end_date],
    );
    this.scheduleSave();
  }

  async listBudgets(): Promise<Budget[]> {
    return this.query(
      "SELECT id, account_pattern, period_type, amount, currency, start_date, end_date, created_at FROM budget ORDER BY account_pattern",
      [],
      (row) => ({
        id: row.id as string,
        account_pattern: row.account_pattern as string,
        period_type: row.period_type as "monthly" | "yearly",
        amount: row.amount as string,
        currency: row.currency as string,
        start_date: (row.start_date as string) || null,
        end_date: (row.end_date as string) || null,
        created_at: row.created_at as string,
      }),
    );
  }

  async updateBudget(budget: Budget): Promise<void> {
    this.run(
      `UPDATE budget SET account_pattern = ?, period_type = ?, amount = ?, currency = ?, start_date = ?, end_date = ? WHERE id = ?`,
      [budget.account_pattern, budget.period_type, budget.amount, budget.currency, budget.start_date, budget.end_date, budget.id],
    );
    this.scheduleSave();
  }

  async deleteBudget(id: string): Promise<void> {
    this.run("DELETE FROM budget WHERE id = ?", [id]);
    this.scheduleSave();
  }

  // ---- Backend: Exchange rates ----

  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
    // Check existing source priority before overwriting
    const existing = this.queryOne(
      "SELECT source FROM exchange_rate WHERE date = ? AND from_currency = ? AND to_currency = ?",
      [rate.date, rate.from_currency, rate.to_currency],
      (row) => row.source as string,
    );
    if (existing !== null && sourcePriority(existing) > sourcePriority(rate.source)) {
      return; // Don't overwrite higher-priority source
    }

    this.run(
      "DELETE FROM exchange_rate WHERE date = ? AND from_currency = ? AND to_currency = ?",
      [rate.date, rate.from_currency, rate.to_currency],
    );
    this.run(
      "INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source) VALUES (?, ?, ?, ?, ?, ?)",
      [
        rate.id,
        rate.date,
        rate.from_currency,
        rate.to_currency,
        rate.rate,
        rate.source,
      ],
    );
    this.scheduleSave();
  }

  async recordExchangeRateBatch(rates: ExchangeRate[]): Promise<void> {
    if (rates.length === 0) return;

    // Fetch existing sources for all (date, from, to) tuples in one query
    const keys = rates.map((r) => `${r.date}|${r.from_currency}|${r.to_currency}`);
    const uniqueKeys = [...new Set(keys)];
    const placeholders = uniqueKeys.map(() => "(?, ?, ?)").join(", ");
    const params: unknown[] = [];
    for (const key of uniqueKeys) {
      const [date, from, to] = key.split("|");
      params.push(date, from, to);
    }

    const existingSources = new Map<string, string>();
    if (uniqueKeys.length > 0) {
      const rows = this.query(
        `SELECT date, from_currency, to_currency, source FROM exchange_rate WHERE (date, from_currency, to_currency) IN (VALUES ${placeholders})`,
        params,
        (row) => ({
          key: `${row.date}|${row.from_currency}|${row.to_currency}`,
          source: row.source as string,
        }),
      );
      for (const row of rows) {
        existingSources.set(row.key, row.source);
      }
    }

    const wasInTransaction = this.inTransaction;
    if (!wasInTransaction) this.beginTransaction();
    try {
      for (const rate of rates) {
        const key = `${rate.date}|${rate.from_currency}|${rate.to_currency}`;
        const existing = existingSources.get(key);
        if (existing !== undefined && sourcePriority(existing) > sourcePriority(rate.source)) {
          continue;
        }

        this.run(
          "DELETE FROM exchange_rate WHERE date = ? AND from_currency = ? AND to_currency = ?",
          [rate.date, rate.from_currency, rate.to_currency],
        );
        this.run(
          "INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source) VALUES (?, ?, ?, ?, ?, ?)",
          [rate.id, rate.date, rate.from_currency, rate.to_currency, rate.rate, rate.source],
        );
      }
      if (!wasInTransaction) this.commitTransaction();
    } catch (e) {
      if (!wasInTransaction) this.rollbackTransaction();
      throw e;
    }
  }

  async getExchangeRate(
    from: string,
    to: string,
    date: string,
  ): Promise<string | null> {
    // Direct lookup
    const direct = this.queryOne(
      "SELECT rate FROM exchange_rate WHERE from_currency = ? AND to_currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
      [from, to, date],
      (row) => row.rate as string,
    );
    if (direct !== null) return direct;

    // Inverse fallback: look for to→from and invert
    const inverse = this.queryOne(
      "SELECT rate FROM exchange_rate WHERE from_currency = ? AND to_currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
      [to, from, date],
      (row) => row.rate as string,
    );
    if (inverse !== null) {
      const invRate = new Decimal(inverse);
      if (invRate.isZero()) return null;
      return new Decimal(1).div(invRate).toString();
    }

    return null;
  }

  async getExchangeRatesBatch(
    pairs: { currency: string; date: string }[],
    baseCurrency: string,
  ): Promise<Map<string, boolean>> {
    if (pairs.length === 0) return new Map();

    // Collect unique currencies
    const currencies = [...new Set(pairs.map((p) => p.currency))];
    if (currencies.length === 0) return new Map();

    // Fetch all rates for these currencies to/from baseCurrency in two queries
    const ph = currencies.map(() => "?").join(", ");

    // Direct: from_currency IN currencies, to_currency = baseCurrency
    const directRows = this.query(
      `SELECT from_currency, date FROM exchange_rate WHERE from_currency IN (${ph}) AND to_currency = ?`,
      [...currencies, baseCurrency],
      (row) => ({ currency: row.from_currency as string, date: row.date as string }),
    );

    // Inverse: from_currency = baseCurrency, to_currency IN currencies
    const inverseRows = this.query(
      `SELECT to_currency AS currency, date FROM exchange_rate WHERE from_currency = ? AND to_currency IN (${ph})`,
      [baseCurrency, ...currencies],
      (row) => ({ currency: row.currency as string, date: row.date as string }),
    );

    // Build index: currency → sorted dates with rates
    const rateIndex = new Map<string, string[]>();
    for (const row of [...directRows, ...inverseRows]) {
      let dates = rateIndex.get(row.currency);
      if (!dates) {
        dates = [];
        rateIndex.set(row.currency, dates);
      }
      dates.push(row.date);
    }
    // Sort each currency's dates
    for (const dates of rateIndex.values()) {
      dates.sort();
    }

    // For each pair, check if a rate exists on or before the given date
    const result = new Map<string, boolean>();
    for (const { currency, date } of pairs) {
      const key = `${currency}:${date}`;
      const dates = rateIndex.get(currency);
      if (!dates || dates.length === 0) {
        result.set(key, false);
        continue;
      }
      // Binary search for last date <= target
      let lo = 0, hi = dates.length - 1;
      let found = false;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= date) {
          found = true;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      result.set(key, found);
    }

    return result;
  }

  async listExchangeRates(
    from?: string,
    to?: string,
  ): Promise<ExchangeRate[]> {
    let sql =
      "SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (from) {
      conditions.push("from_currency = ?");
      params.push(from);
    }
    if (to) {
      conditions.push("to_currency = ?");
      params.push(to);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY date DESC";

    return this.query(sql, params, mapExchangeRate);
  }

  // ---- Backend: Ledger file import/export ----

  async importLedgerFile(content: string): Promise<LedgerImportResult> {
    const { importLedger } = await import("./browser-ledger-file.js");
    this.beginTransaction();
    try {
      const result = await importLedger(this, content);
      this.commitTransaction();
      return result;
    } catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  }

  async exportLedgerFile(): Promise<string> {
    const { exportLedger } = await import("./browser-ledger-file.js");
    return exportLedger(this);
  }

  // ---- Backend: Metadata ----

  async setMetadata(entryId: string, entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.run(
        "INSERT OR REPLACE INTO journal_entry_metadata (journal_entry_id, key, value) VALUES (?, ?, ?)",
        [entryId, key, value],
      );
    }
    this.scheduleSave();
  }

  async getMetadata(entryId: string): Promise<Record<string, string>> {
    const rows = this.query(
      "SELECT key, value FROM journal_entry_metadata WHERE journal_entry_id = ? ORDER BY key",
      [entryId],
      (row) => ({ key: row.key as string, value: row.value as string }),
    );
    const result: Record<string, string> = {};
    for (const { key, value } of rows) {
      result[key] = value;
    }
    return result;
  }

  // ---- Backend: Account Metadata ----

  async setAccountMetadata(accountId: string, entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.run(
        "INSERT OR REPLACE INTO account_metadata (account_id, key, value) VALUES (?, ?, ?)",
        [accountId, key, value],
      );
    }
    this.scheduleSave();
  }

  async getAccountMetadata(accountId: string): Promise<Record<string, string>> {
    const rows = this.query(
      "SELECT key, value FROM account_metadata WHERE account_id = ? ORDER BY key",
      [accountId],
      (row) => ({ key: row.key as string, value: row.value as string }),
    );
    const result: Record<string, string> = {};
    for (const { key, value } of rows) {
      result[key] = value;
    }
    return result;
  }

  // ---- Backend: Metadata query ----

  async queryEntriesByMetadata(key: string, value: string): Promise<string[]> {
    return this.query(
      `SELECT DISTINCT m.journal_entry_id
       FROM journal_entry_metadata m
       JOIN journal_entry je ON je.id = m.journal_entry_id
       WHERE m.key = ? AND m.value = ? AND je.status != 'voided'
       ORDER BY je.date DESC`,
      [key, value],
      (row) => row.journal_entry_id as string,
    );
  }

  // ---- Backend: Raw transactions ----

  async storeRawTransaction(source: string, data: string): Promise<void> {
    this.run(
      "INSERT OR REPLACE INTO raw_transaction (source, data) VALUES (?, ?)",
      [source, data],
    );
    this.scheduleSave();
  }

  async getRawTransaction(source: string): Promise<string | null> {
    return this.queryOne(
      "SELECT data FROM raw_transaction WHERE source = ?",
      [source],
      (row) => row.data as string,
    );
  }

  async queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>> {
    return this.query(
      "SELECT source, data FROM raw_transaction WHERE source LIKE ? ORDER BY source",
      [sourcePrefix + "%"],
      (row) => ({ source: row.source as string, data: row.data as string }),
    );
  }

  // ---- Backend: Etherscan ----

  async listEtherscanAccounts(): Promise<EtherscanAccount[]> {
    return this.query(
      "SELECT address, chain_id, label FROM etherscan_account ORDER BY label, chain_id",
      [],
      (row) => ({
        address: row.address as string,
        chain_id: row.chain_id as number,
        label: row.label as string,
      }),
    );
  }

  async addEtherscanAccount(
    address: string,
    chainId: number,
    label: string,
  ): Promise<void> {
    this.run(
      "INSERT OR REPLACE INTO etherscan_account (address, chain_id, label) VALUES (?, ?, ?)",
      [address.toLowerCase(), chainId, label],
    );
    this.scheduleSave();
  }

  async removeEtherscanAccount(
    address: string,
    chainId: number,
  ): Promise<void> {
    this.run(
      "DELETE FROM etherscan_account WHERE address = ? AND chain_id = ?",
      [address.toLowerCase(), chainId],
    );
    this.scheduleSave();
  }

  async syncEtherscan(
    apiKey: string,
    address: string,
    label: string,
    chainId: number,
  ): Promise<EtherscanSyncResult> {
    const { syncEtherscanWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    this.beginTransaction();
    try {
      const result = await syncEtherscanWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
      this.commitTransaction();
      return result;
    } catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  }

  // ---- Exchange accounts (CEX) ----

  async listExchangeAccounts(): Promise<import("./cex/types.js").ExchangeAccount[]> {
    return this.query(
      "SELECT id, exchange, label, api_key, api_secret, passphrase, last_sync, created_at FROM exchange_account ORDER BY created_at",
      [],
      (row) => ({
        id: row.id as string,
        exchange: row.exchange as import("./cex/types.js").ExchangeId,
        label: row.label as string,
        api_key: row.api_key as string,
        api_secret: row.api_secret as string,
        passphrase: (row.passphrase as string) ?? null,
        last_sync: (row.last_sync as string) ?? null,
        created_at: row.created_at as string,
      }),
    );
  }

  async addExchangeAccount(account: import("./cex/types.js").ExchangeAccount): Promise<void> {
    this.run(
      `INSERT INTO exchange_account (id, exchange, label, api_key, api_secret, linked_etherscan_account_id, passphrase, last_sync, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [account.id, account.exchange, account.label, account.api_key, account.api_secret,
       null, account.passphrase ?? null, account.last_sync, account.created_at],
    );
    this.scheduleSave();
  }

  async updateExchangeAccount(id: string, updates: Partial<import("./cex/types.js").ExchangeAccount>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.label !== undefined) { sets.push("label = ?"); params.push(updates.label); }
    if (updates.api_key !== undefined) { sets.push("api_key = ?"); params.push(updates.api_key); }
    if (updates.api_secret !== undefined) { sets.push("api_secret = ?"); params.push(updates.api_secret); }
    if (updates.passphrase !== undefined) { sets.push("passphrase = ?"); params.push(updates.passphrase); }
    if (updates.last_sync !== undefined) { sets.push("last_sync = ?"); params.push(updates.last_sync); }
    if (sets.length === 0) return;
    params.push(id);
    this.run(`UPDATE exchange_account SET ${sets.join(", ")} WHERE id = ?`, params);
    this.scheduleSave();
  }

  async removeExchangeAccount(id: string): Promise<void> {
    this.run("DELETE FROM exchange_account WHERE id = ?", [id]);
    this.scheduleSave();
  }

  // ---- Currency origins ----

  async getCurrencyOrigins(): Promise<CurrencyOrigin[]> {
    return this.query(
      `SELECT DISTINCT li.currency,
         CASE
           WHEN je.source LIKE 'etherscan:%' THEN 'etherscan'
           ELSE je.source
         END AS origin
       FROM line_item li
       JOIN journal_entry je ON li.journal_entry_id = je.id
       WHERE je.status != 'voided'`,
      [],
      (row) => ({
        currency: row.currency as string,
        origin: row.origin as string,
      }),
    );
  }

  // ---- Currency rate source management ----

  async getCurrencyRateSources(): Promise<CurrencyRateSource[]> {
    return this.query(
      "SELECT currency, rate_source, set_by, updated_at FROM currency_rate_source ORDER BY currency",
      [],
      (row) => ({
        currency: row.currency as string,
        rate_source: (row.rate_source as string | null) ?? null,
        set_by: row.set_by as string,
        updated_at: row.updated_at as string,
      }),
    );
  }

  async setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);

    // Check existing row for priority
    const existing = this.queryOne(
      "SELECT set_by FROM currency_rate_source WHERE currency = ?",
      [currency],
      (row) => row.set_by as string,
    );

    if (existing !== null) {
      const existingPriority = setByPriority(existing);
      const newPriority = setByPriority(setBy);
      if (newPriority < existingPriority) {
        return false; // Skip: existing has higher priority
      }
      this.run(
        "UPDATE currency_rate_source SET rate_source = ?, set_by = ?, updated_at = ? WHERE currency = ?",
        [rateSource, setBy, today, currency],
      );
    } else {
      this.run(
        "INSERT INTO currency_rate_source (currency, rate_source, set_by, updated_at) VALUES (?, ?, ?, ?)",
        [currency, rateSource, setBy, today],
      );
    }
    this.scheduleSave();
    return true;
  }

  async clearAutoRateSources(): Promise<void> {
    this.db.exec("DELETE FROM currency_rate_source WHERE set_by = 'auto'");
    this.scheduleSave();
  }

  async clearNonUserRateSources(): Promise<void> {
    this.db.exec("DELETE FROM currency_rate_source WHERE set_by != 'user'");
    this.scheduleSave();
  }

  // ---- Balance assertions ----

  async createBalanceAssertion(assertion: BalanceAssertion): Promise<void> {
    // Compute actual balance at the assertion date
    const account = this.getAccountById(assertion.account_id);
    if (!account) throw new Error(`account ${assertion.account_id} not found`);

    const balances = this.sumLineItems([assertion.account_id], assertion.date);
    const actual = balances.find((b) => b.currency === assertion.currency);
    const actualAmount = actual ? actual.amount : "0";
    const isPassing = actualAmount === assertion.expected_balance ||
      new Decimal(actualAmount).eq(new Decimal(assertion.expected_balance));

    this.run(
      "INSERT INTO balance_assertion (id, account_id, date, currency, expected_balance, is_passing, actual_balance) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [assertion.id, assertion.account_id, assertion.date, assertion.currency, assertion.expected_balance, isPassing ? 1 : 0, actualAmount],
    );
    this.scheduleSave();
  }

  async listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]> {
    let sql = "SELECT id, account_id, date, currency, expected_balance, is_passing, actual_balance FROM balance_assertion";
    const params: unknown[] = [];
    if (accountId) {
      sql += " WHERE account_id = ?";
      params.push(accountId);
    }
    sql += " ORDER BY date DESC";
    return this.query(sql, params, (row) => ({
      id: row.id as string,
      account_id: row.account_id as string,
      date: row.date as string,
      currency: row.currency as string,
      expected_balance: row.expected_balance as string,
      is_passing: (row.is_passing as number) !== 0,
      actual_balance: row.actual_balance as string | null,
    }));
  }

  async checkBalanceAssertions(): Promise<BalanceAssertionResult[]> {
    const assertions = await this.listBalanceAssertions();
    if (assertions.length === 0) return [];

    // Batch: compute balances once per distinct date
    const distinctDates = [...new Set(assertions.map((a) => a.date))];
    const balancesByDate = new Map<string, Map<string, CurrencyBalance[]>>();
    for (const date of distinctDates) {
      balancesByDate.set(date, this.sumAllLineItemsByAccount(date));
    }

    const results: BalanceAssertionResult[] = [];

    for (const assertion of assertions) {
      const allBalances = balancesByDate.get(assertion.date)!;
      const accountBalances = allBalances.get(assertion.account_id) ?? [];
      const actual = accountBalances.find((b) => b.currency === assertion.currency);
      const actualAmount = actual ? actual.amount : "0";
      const expected = new Decimal(assertion.expected_balance);
      const actualDec = new Decimal(actualAmount);
      const isPassing = actualDec.eq(expected);
      const difference = actualDec.minus(expected).toString();

      // Update stored assertion
      this.run(
        "UPDATE balance_assertion SET is_passing = ?, actual_balance = ? WHERE id = ?",
        [isPassing ? 1 : 0, actualAmount, assertion.id],
      );

      results.push({
        assertion: { ...assertion, is_passing: isPassing, actual_balance: actualAmount },
        actual_balance: actualAmount,
        is_passing: isPassing,
        difference,
      });
    }

    this.scheduleSave();
    return results;
  }

  // ---- Integrity checks ----

  async countOrphanedLineItems(): Promise<number> {
    const result = this.queryOne(
      "SELECT COUNT(*) as cnt FROM line_item WHERE journal_entry_id NOT IN (SELECT id FROM journal_entry) OR account_id NOT IN (SELECT id FROM account)",
      [],
      (row) => row.cnt as number,
    );
    return result ?? 0;
  }

  async countDuplicateSources(): Promise<number> {
    const result = this.queryOne(
      "SELECT COUNT(*) as cnt FROM (SELECT source, COUNT(*) as c FROM journal_entry WHERE source LIKE 'etherscan:%' GROUP BY source HAVING c > 1)",
      [],
      (row) => row.cnt as number,
    );
    return result ?? 0;
  }

  // ---- Reconciliation ----

  async getUnreconciledLineItems(accountId: string, currency: string, upToDate?: string): Promise<UnreconciledLineItem[]> {
    let sql = `SELECT li.id as line_item_id, li.journal_entry_id as entry_id, je.date as entry_date,
                      je.description as entry_description, li.account_id, li.currency, li.amount,
                      li.is_reconciled
               FROM line_item li
               JOIN journal_entry je ON je.id = li.journal_entry_id
               WHERE li.account_id = ? AND li.currency = ? AND li.is_reconciled = 0
                 AND je.status != 'voided'`;
    const params: unknown[] = [accountId, currency];
    if (upToDate) {
      sql += " AND je.date <= ?";
      params.push(upToDate);
    }
    sql += " ORDER BY je.date ASC, je.created_at ASC";
    return this.query(sql, params, (row) => ({
      line_item_id: row.line_item_id as string,
      entry_id: row.entry_id as string,
      entry_date: row.entry_date as string,
      entry_description: row.entry_description as string,
      account_id: row.account_id as string,
      currency: row.currency as string,
      amount: row.amount as string,
      is_reconciled: (row.is_reconciled as number) !== 0,
    }));
  }

  async markReconciled(reconciliation: Reconciliation, lineItemIds: string[]): Promise<void> {
    const wasInTransaction = this.inTransaction;
    if (!wasInTransaction) this.beginTransaction();
    try {
      // Insert reconciliation record
      this.run(
        `INSERT INTO reconciliation (id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [reconciliation.id, reconciliation.account_id, reconciliation.statement_date,
         reconciliation.statement_balance, reconciliation.currency, reconciliation.reconciled_at,
         lineItemIds.length],
      );
      // Mark line items as reconciled and insert junction rows
      for (const liId of lineItemIds) {
        this.run("UPDATE line_item SET is_reconciled = 1 WHERE id = ?", [liId]);
        this.run("INSERT INTO reconciliation_line_item (reconciliation_id, line_item_id) VALUES (?, ?)",
          [reconciliation.id, liId]);
      }
      if (!wasInTransaction) this.commitTransaction();
    } catch (e) {
      if (!wasInTransaction) this.rollbackTransaction();
      throw e;
    }
  }

  async listReconciliations(accountId?: string): Promise<Reconciliation[]> {
    let sql = "SELECT id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count FROM reconciliation";
    const params: unknown[] = [];
    if (accountId) {
      sql += " WHERE account_id = ?";
      params.push(accountId);
    }
    sql += " ORDER BY reconciled_at DESC";
    return this.query(sql, params, (row) => ({
      id: row.id as string,
      account_id: row.account_id as string,
      statement_date: row.statement_date as string,
      statement_balance: row.statement_balance as string,
      currency: row.currency as string,
      reconciled_at: row.reconciled_at as string,
      line_item_count: row.line_item_count as number,
    }));
  }

  async getReconciliationDetail(id: string): Promise<{ reconciliation: Reconciliation; lineItemIds: string[] } | null> {
    const rec = this.queryOne(
      "SELECT id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count FROM reconciliation WHERE id = ?",
      [id],
      (row) => ({
        id: row.id as string,
        account_id: row.account_id as string,
        statement_date: row.statement_date as string,
        statement_balance: row.statement_balance as string,
        currency: row.currency as string,
        reconciled_at: row.reconciled_at as string,
        line_item_count: row.line_item_count as number,
      }),
    );
    if (!rec) return null;
    const lineItemIds = this.query(
      "SELECT line_item_id FROM reconciliation_line_item WHERE reconciliation_id = ?",
      [id],
      (row) => row.line_item_id as string,
    );
    return { reconciliation: rec, lineItemIds };
  }

  // ---- Recurring templates ----

  async createRecurringTemplate(template: RecurringTemplate): Promise<void> {
    this.run(
      `INSERT INTO recurring_template (id, description, frequency, interval_val, next_date, end_date, is_active, line_items_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [template.id, template.description, template.frequency, template.interval,
       template.next_date, template.end_date, template.is_active ? 1 : 0,
       JSON.stringify(template.line_items), template.created_at],
    );
    this.scheduleSave();
  }

  async listRecurringTemplates(): Promise<RecurringTemplate[]> {
    return this.query(
      "SELECT id, description, frequency, interval_val, next_date, end_date, is_active, line_items_json, created_at FROM recurring_template ORDER BY next_date ASC",
      [],
      (row) => ({
        id: row.id as string,
        description: row.description as string,
        frequency: row.frequency as RecurringTemplate["frequency"],
        interval: row.interval_val as number,
        next_date: row.next_date as string,
        end_date: (row.end_date as string) || null,
        is_active: (row.is_active as number) !== 0,
        line_items: JSON.parse((row.line_items_json as string) || "[]"),
        created_at: row.created_at as string,
      }),
    );
  }

  async updateRecurringTemplate(template: RecurringTemplate): Promise<void> {
    this.run(
      `UPDATE recurring_template SET description = ?, frequency = ?, interval_val = ?,
       next_date = ?, end_date = ?, is_active = ?, line_items_json = ?
       WHERE id = ?`,
      [template.description, template.frequency, template.interval,
       template.next_date, template.end_date, template.is_active ? 1 : 0,
       JSON.stringify(template.line_items), template.id],
    );
    this.scheduleSave();
  }

  async deleteRecurringTemplate(id: string): Promise<void> {
    this.run("DELETE FROM recurring_template WHERE id = ?", [id]);
    this.scheduleSave();
  }

  // ---- Database export/import ----

  async exportDatabase(): Promise<Uint8Array> {
    return this.db.export();
  }

  async importDatabase(data: Uint8Array): Promise<void> {
    // Validate by opening the data and checking schema version
    const testDb = new this.sql.Database(data);
    try {
      const versionRows = testDb.exec("SELECT version FROM schema_version");
      if (versionRows.length === 0 || versionRows[0].values.length === 0) {
        throw new Error("Invalid database: missing schema_version");
      }
    } catch (e) {
      testDb.close();
      if (e instanceof Error && e.message.includes("Invalid database")) throw e;
      throw new Error("Invalid database file");
    }
    testDb.close();

    // Replace current database
    this.db.close();
    this.db = new this.sql.Database(data);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.scheduleSave();
  }

  // ---- Data management ----

  async clearExchangeRates(): Promise<void> {
    this.db.exec("DELETE FROM exchange_rate");
    this.scheduleSave();
  }

  async clearLedgerData(): Promise<void> {
    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      DELETE FROM reconciliation_line_item;
      DELETE FROM reconciliation;
      DELETE FROM lot_disposal;
      DELETE FROM lot;
      DELETE FROM line_item;
      DELETE FROM journal_entry_metadata;
      DELETE FROM balance_assertion;
      DELETE FROM audit_log;
      DELETE FROM journal_entry;
      DELETE FROM raw_transaction;
      DELETE FROM currency_rate_source;
      DELETE FROM budget;
      DELETE FROM recurring_template;
      DELETE FROM currency_token_address;
      DELETE FROM account_metadata;
      DELETE FROM account_closure;
      DELETE FROM account;
      DELETE FROM currency;
      UPDATE exchange_account SET last_sync = NULL;
      PRAGMA foreign_keys=ON;
    `);
    this.scheduleSave();
  }

  async clearAllData(): Promise<void> {
    this.db.exec(`
      DELETE FROM reconciliation_line_item;
      DELETE FROM reconciliation;
      DELETE FROM lot_disposal;
      DELETE FROM lot;
      DELETE FROM line_item;
      DELETE FROM journal_entry_metadata;
      DELETE FROM balance_assertion;
      DELETE FROM audit_log;
      DELETE FROM journal_entry;
      DELETE FROM exchange_rate;
      DELETE FROM raw_transaction;
      DELETE FROM currency_rate_source;
      DELETE FROM budget;
      DELETE FROM recurring_template;
      DELETE FROM currency_token_address;
      DELETE FROM account_metadata;
      DELETE FROM account_closure;
      DELETE FROM account;
      DELETE FROM exchange_account;
      DELETE FROM etherscan_account;
      DELETE FROM currency;
    `);
    this.scheduleSave();
  }
}
