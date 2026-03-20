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
import type { PersistedFrenchTaxReport, FrenchTaxReport } from "./utils/french-tax.js";
import { parseTags } from "./utils/tags.js";
import { isSpamCurrency } from "./currency-validation.js";

/** Yield to the browser event loop so click events can process. No-op in non-browser (test) environments. */
const _isBrowser = typeof requestAnimationFrame === "function";
const yieldToEventLoop = (): Promise<void> =>
  _isBrowser ? new Promise(r => requestAnimationFrame(() => r())) : Promise.resolve();

// ---- IndexedDB persistence ----

const IDB_NAME = "dledger";
const IDB_STORE = "database";
const IDB_KEY = "main";
const SQL_VAR_LIMIT = 900;

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
    code TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (code, asset_type, param)
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
    created_at TEXT NOT NULL,
    opened_at TEXT
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
    description_data TEXT,
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
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL,
    lot_id TEXT REFERENCES lot(id),
    is_reconciled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_line_item_account ON line_item(account_id);
CREATE INDEX IF NOT EXISTS idx_line_item_currency ON line_item(currency);

CREATE TABLE IF NOT EXISTS lot (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL,
    cost_basis_currency_asset_type TEXT NOT NULL DEFAULT '',
    cost_basis_currency_param TEXT NOT NULL DEFAULT '',
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (cost_basis_currency, cost_basis_currency_asset_type, cost_basis_currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_lot_account_currency ON lot(account_id, currency);
CREATE INDEX IF NOT EXISTS idx_lot_open ON lot(account_id, currency, is_closed, acquired_date);

CREATE TABLE IF NOT EXISTS lot_disposal (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lot(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    quantity TEXT NOT NULL,
    proceeds_per_unit TEXT NOT NULL,
    proceeds_currency TEXT NOT NULL,
    proceeds_currency_asset_type TEXT NOT NULL DEFAULT '',
    proceeds_currency_param TEXT NOT NULL DEFAULT '',
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL,
    FOREIGN KEY (proceeds_currency, proceeds_currency_asset_type, proceeds_currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_date ON lot_disposal(disposal_date);

CREATE TABLE IF NOT EXISTS exchange_rate (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL,
    from_currency_asset_type TEXT NOT NULL DEFAULT '',
    from_currency_param TEXT NOT NULL DEFAULT '',
    to_currency TEXT NOT NULL,
    to_currency_asset_type TEXT NOT NULL DEFAULT '',
    to_currency_param TEXT NOT NULL DEFAULT '',
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    FOREIGN KEY (from_currency, from_currency_asset_type, from_currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (to_currency, to_currency_asset_type, to_currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

CREATE TABLE IF NOT EXISTS balance_assertion (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT,
    is_strict INTEGER NOT NULL DEFAULT 0,
    include_subaccounts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
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
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    rate_source TEXT NOT NULL,
    rate_source_id TEXT NOT NULL DEFAULT '',
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (currency, asset_type, param)
);

CREATE TABLE IF NOT EXISTS budget (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
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
    opened_at TEXT,
    closed_at TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_link (
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    link_name TEXT NOT NULL,
    PRIMARY KEY (journal_entry_id, link_name)
);
CREATE INDEX IF NOT EXISTS idx_entry_link_name ON entry_link(link_name);

CREATE TABLE IF NOT EXISTS french_tax_report (
    tax_year INTEGER PRIMARY KEY NOT NULL,
    generated_at TEXT NOT NULL,
    final_acquisition_cost TEXT NOT NULL,
    report_json TEXT NOT NULL
);
`;

// ---- Row type helpers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function mapCurrency(row: Row): Currency {
  return {
    code: row.code,
    asset_type: row.asset_type ?? "",
    param: row.param ?? "",
    name: row.name,
    decimal_places: row.decimal_places,
    is_base: row.is_base !== 0,
    is_hidden: row.is_hidden !== 0,
  };
}

function inferAccountTypeFromPath(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets": case "Asset": return "asset";
    case "Liabilities": case "Liability": return "liability";
    case "Equity": return "equity";
    case "Income": case "Revenue": return "revenue";
    case "Expenses": case "Expense": return "expense";
    default: return "expense";
  }
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
    opened_at: row.opened_at ?? null,
  };
}

function mapJournalEntry(row: Row): JournalEntry {
  return {
    id: row.id,
    date: row.date,
    description: row.description,
    ...(row.description_data ? { description_data: row.description_data } : {}),
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
    currency_asset_type: row.currency_asset_type ?? "",
    currency_param: row.currency_param ?? "",
    amount: row.amount,
    lot_id: row.lot_id ?? null,
  };
}

function mapExchangeRate(row: Row): ExchangeRate {
  return {
    id: row.id,
    date: row.date,
    from_currency: row.from_currency,
    from_currency_asset_type: row.from_currency_asset_type ?? "",
    from_currency_param: row.from_currency_param ?? "",
    to_currency: row.to_currency,
    to_currency_asset_type: row.to_currency_asset_type ?? "",
    to_currency_param: row.to_currency_param ?? "",
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

  private static initFreshSchema(db: Database): void {
    db.exec(SCHEMA_SQL);
    db.exec("CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value)");
    // Reconciliation tables (v9) — is_reconciled already in base SCHEMA_SQL
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
    // Token address mapping (v12, updated v17)
    db.exec(`CREATE TABLE IF NOT EXISTS currency_token_address (
      currency TEXT NOT NULL, asset_type TEXT NOT NULL DEFAULT '', param TEXT NOT NULL DEFAULT '',
      chain TEXT NOT NULL, contract_address TEXT NOT NULL,
      PRIMARY KEY (currency, asset_type, param, chain)
    )`);
    // Account metadata (v14)
    db.exec(`CREATE TABLE IF NOT EXISTS account_metadata (
      account_id TEXT NOT NULL REFERENCES account(id),
      key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (account_id, key)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value)");
    // Entry links (v16)
    db.exec(`CREATE TABLE IF NOT EXISTS entry_link (
      journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
      link_name TEXT NOT NULL,
      PRIMARY KEY (journal_entry_id, link_name)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_entry_link_name ON entry_link(link_name)");
    db.exec("INSERT INTO schema_version (version) VALUES (22)");
  }

  static async createInMemory(): Promise<SqlJsBackend> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const backend = new SqlJsBackend(db, SQL);
    db.exec("PRAGMA foreign_keys=ON");
    SqlJsBackend.initFreshSchema(db);
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
      SqlJsBackend.initFreshSchema(db);
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
        if (currentVersion < 15) {
          db.exec("ALTER TABLE balance_assertion ADD COLUMN is_strict INTEGER NOT NULL DEFAULT 0");
          db.exec("ALTER TABLE balance_assertion ADD COLUMN include_subaccounts INTEGER NOT NULL DEFAULT 0");
        }
        if (currentVersion < 16) {
          // Migrate v15 → v16: entry_link table
          db.exec(`CREATE TABLE IF NOT EXISTS entry_link (
            journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
            link_name TEXT NOT NULL,
            PRIMARY KEY (journal_entry_id, link_name)
          )`);
          db.exec("CREATE INDEX IF NOT EXISTS idx_entry_link_name ON entry_link(link_name)");
          // Migrate links from metadata to entry_link table
          const linkRows = db.exec("SELECT journal_entry_id, value FROM journal_entry_metadata WHERE key = 'links'");
          if (linkRows.length > 0 && linkRows[0].values.length > 0) {
            const insertStmt = db.prepare("INSERT OR IGNORE INTO entry_link (journal_entry_id, link_name) VALUES (?, ?)");
            for (const row of linkRows[0].values) {
              const entryIdVal = row[0] as string;
              const value = row[1] as string;
              const links = value.split(/\s+/).map(l => l.replace(/^\^+/, "").toLowerCase()).filter(l => l.length > 0);
              for (const link of links) {
                insertStmt.bind([entryIdVal, link]);
                insertStmt.step();
                insertStmt.reset();
              }
            }
            insertStmt.free();
          }
          db.exec("DELETE FROM journal_entry_metadata WHERE key = 'links'");
        }
        if (currentVersion < 17) {
          // Migrate v16 → v17: add asset_type + param composite key columns
          db.exec(`
PRAGMA foreign_keys = OFF;

-- 1. Recreate currency with composite PK (code, asset_type, param)
CREATE TABLE currency_new (
    code TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (code, asset_type, param)
);
INSERT INTO currency_new (code, name, decimal_places, is_base, is_hidden)
    SELECT code, name, decimal_places, is_base, is_hidden FROM currency;
DROP TABLE currency;
ALTER TABLE currency_new RENAME TO currency;

-- 2. Recreate line_item with currency_asset_type + currency_param
CREATE TABLE line_item_new (
    id TEXT PRIMARY KEY NOT NULL,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL,
    lot_id TEXT REFERENCES lot(id),
    is_reconciled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO line_item_new (id, journal_entry_id, account_id, currency, amount, lot_id, is_reconciled)
    SELECT id, journal_entry_id, account_id, currency, amount, lot_id, is_reconciled FROM line_item;
DROP TABLE line_item;
ALTER TABLE line_item_new RENAME TO line_item;
CREATE INDEX idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX idx_line_item_account ON line_item(account_id);
CREATE INDEX idx_line_item_currency ON line_item(currency);

-- 3. Recreate lot with currency + cost_basis_currency type/param
CREATE TABLE lot_new (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL,
    cost_basis_currency_asset_type TEXT NOT NULL DEFAULT '',
    cost_basis_currency_param TEXT NOT NULL DEFAULT '',
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (cost_basis_currency, cost_basis_currency_asset_type, cost_basis_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO lot_new (id, account_id, currency, acquired_date, original_quantity, remaining_quantity,
                     cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed)
    SELECT id, account_id, currency, acquired_date, original_quantity, remaining_quantity,
           cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed FROM lot;
DROP TABLE lot;
ALTER TABLE lot_new RENAME TO lot;
CREATE INDEX idx_lot_account_currency ON lot(account_id, currency);
CREATE INDEX idx_lot_open ON lot(account_id, currency, is_closed, acquired_date);

-- 4. Recreate lot_disposal with proceeds_currency type/param
CREATE TABLE lot_disposal_new (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lot(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    quantity TEXT NOT NULL,
    proceeds_per_unit TEXT NOT NULL,
    proceeds_currency TEXT NOT NULL,
    proceeds_currency_asset_type TEXT NOT NULL DEFAULT '',
    proceeds_currency_param TEXT NOT NULL DEFAULT '',
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL,
    FOREIGN KEY (proceeds_currency, proceeds_currency_asset_type, proceeds_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO lot_disposal_new (id, lot_id, journal_entry_id, quantity, proceeds_per_unit,
                               proceeds_currency, realized_gain_loss, disposal_date)
    SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit,
           proceeds_currency, realized_gain_loss, disposal_date FROM lot_disposal;
DROP TABLE lot_disposal;
ALTER TABLE lot_disposal_new RENAME TO lot_disposal;
CREATE INDEX idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX idx_lot_disposal_date ON lot_disposal(disposal_date);

-- 5. Recreate exchange_rate with from/to currency type/param
CREATE TABLE exchange_rate_new (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL,
    from_currency_asset_type TEXT NOT NULL DEFAULT '',
    from_currency_param TEXT NOT NULL DEFAULT '',
    to_currency TEXT NOT NULL,
    to_currency_asset_type TEXT NOT NULL DEFAULT '',
    to_currency_param TEXT NOT NULL DEFAULT '',
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    FOREIGN KEY (from_currency, from_currency_asset_type, from_currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (to_currency, to_currency_asset_type, to_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO exchange_rate_new (id, date, from_currency, to_currency, rate, source)
    SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate;
DROP TABLE exchange_rate;
ALTER TABLE exchange_rate_new RENAME TO exchange_rate;
CREATE INDEX idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

-- 6. Recreate balance_assertion with currency type/param
CREATE TABLE balance_assertion_new (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT,
    is_strict INTEGER NOT NULL DEFAULT 0,
    include_subaccounts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO balance_assertion_new (id, account_id, date, currency, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts)
    SELECT id, account_id, date, currency, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts FROM balance_assertion;
DROP TABLE balance_assertion;
ALTER TABLE balance_assertion_new RENAME TO balance_assertion;
CREATE INDEX idx_balance_assertion_account ON balance_assertion(account_id);

-- 7. Recreate budget with currency type/param
CREATE TABLE budget_new (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO budget_new (id, account_pattern, period_type, amount, currency, start_date, end_date, created_at)
    SELECT id, account_pattern, period_type, amount, currency, start_date, end_date, created_at FROM budget;
DROP TABLE budget;
ALTER TABLE budget_new RENAME TO budget;

-- 8. Recreate currency_rate_source with composite PK
CREATE TABLE currency_rate_source_new (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    rate_source TEXT NOT NULL,
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (currency, asset_type, param)
);
INSERT INTO currency_rate_source_new (currency, rate_source, set_by, updated_at)
    SELECT currency, rate_source, set_by, updated_at FROM currency_rate_source;
DROP TABLE currency_rate_source;
ALTER TABLE currency_rate_source_new RENAME TO currency_rate_source;

-- 9. Recreate currency_token_address with composite PK
CREATE TABLE currency_token_address_new (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    PRIMARY KEY (currency, asset_type, param, chain)
);
INSERT INTO currency_token_address_new (currency, chain, contract_address)
    SELECT currency, chain, contract_address FROM currency_token_address;
DROP TABLE currency_token_address;
ALTER TABLE currency_token_address_new RENAME TO currency_token_address;

PRAGMA foreign_keys = ON;
          `);
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (17)");
        }
        if (currentVersion < 18) {
          // Migrate v17 → v18: add opened_at column to account
          db.exec("ALTER TABLE account ADD COLUMN opened_at TEXT");
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (18)");
        }
        if (currentVersion < 19) {
          // Migrate v18 → v19: add rate_source_id column to currency_rate_source
          db.exec("ALTER TABLE currency_rate_source ADD COLUMN rate_source_id TEXT NOT NULL DEFAULT ''");
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (19)");
        }
        if (currentVersion < 20) {
          db.exec("DROP TABLE IF EXISTS french_tax_report");
          db.exec(`CREATE TABLE IF NOT EXISTS french_tax_report (
            tax_year INTEGER PRIMARY KEY NOT NULL,
            generated_at TEXT NOT NULL,
            final_acquisition_cost TEXT NOT NULL,
            report_json TEXT NOT NULL
          )`);
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (20)");
        }
        if (currentVersion < 21) {
          try { db.exec("ALTER TABLE exchange_account ADD COLUMN opened_at TEXT"); } catch { /* already exists */ }
          try { db.exec("ALTER TABLE exchange_account ADD COLUMN closed_at TEXT"); } catch { /* already exists */ }
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (21)");
        }
        if (currentVersion < 22) {
          db.exec("ALTER TABLE journal_entry ADD COLUMN description_data TEXT");
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (22)");
        }
        if (currentVersion < 23) {
          db.exec(`CREATE TABLE IF NOT EXISTS bitcoin_account (
            id TEXT PRIMARY KEY NOT NULL,
            address_or_xpub TEXT NOT NULL,
            account_type TEXT NOT NULL DEFAULT 'address',
            derivation_bip INTEGER,
            network TEXT NOT NULL DEFAULT 'mainnet',
            label TEXT NOT NULL,
            last_receive_index INTEGER NOT NULL DEFAULT -1,
            last_change_index INTEGER NOT NULL DEFAULT -1,
            last_sync TEXT,
            created_at TEXT NOT NULL
          )`);
          db.exec(`CREATE TABLE IF NOT EXISTS btc_derived_address (
            address TEXT PRIMARY KEY NOT NULL,
            bitcoin_account_id TEXT NOT NULL REFERENCES bitcoin_account(id) ON DELETE CASCADE,
            change_chain INTEGER NOT NULL DEFAULT 0,
            address_index INTEGER NOT NULL,
            has_transactions INTEGER NOT NULL DEFAULT 0
          )`);
          db.exec("CREATE INDEX IF NOT EXISTS idx_btc_derived_account ON btc_derived_address(bitcoin_account_id)");
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (23)");
        }
        if (currentVersion < 24) {
          db.exec(`CREATE TABLE IF NOT EXISTS solana_account (
            id TEXT PRIMARY KEY NOT NULL,
            address TEXT NOT NULL UNIQUE,
            network TEXT NOT NULL DEFAULT 'mainnet-beta',
            label TEXT NOT NULL,
            last_signature TEXT,
            last_sync TEXT,
            created_at TEXT NOT NULL
          )`);
          db.exec("DELETE FROM schema_version");
          db.exec("INSERT INTO schema_version (version) VALUES (24)");
        }
      }
    }
    // Idempotent cleanup: ensure is_reconciled exists on line_item
    try { db.exec("ALTER TABLE line_item ADD COLUMN is_reconciled INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    // Idempotent cleanup: handle DBs that had old v18 (opening_balance table)
    // but lack the new v18 column (opened_at).
    try { db.exec("ALTER TABLE account ADD COLUMN opened_at TEXT"); } catch { /* already exists */ }
    try { db.exec("DROP TABLE IF EXISTS opening_balance"); } catch { /* ignore */ }
    // Ensure exchange_account has opened_at/closed_at columns (v21)
    try { db.exec("ALTER TABLE exchange_account ADD COLUMN opened_at TEXT"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE exchange_account ADD COLUMN closed_at TEXT"); } catch { /* already exists */ }
    // Ensure raw_transaction table exists (added post-v2)
    try {
      db.exec("CREATE TABLE IF NOT EXISTS raw_transaction (source TEXT PRIMARY KEY, data TEXT NOT NULL)");
    } catch {
      // ignore if already exists
    }
    // Repair broken french_tax_report table (may lack NOT NULL columns from failed migration)
    try {
      db.exec("SELECT generated_at, final_acquisition_cost, report_json FROM french_tax_report LIMIT 0");
    } catch {
      db.exec("DROP TABLE IF EXISTS french_tax_report");
      db.exec(`CREATE TABLE IF NOT EXISTS french_tax_report (
        tax_year INTEGER PRIMARY KEY NOT NULL,
        generated_at TEXT NOT NULL,
        final_acquisition_cost TEXT NOT NULL,
        report_json TEXT NOT NULL
      )`);
      backend.scheduleSave();
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

  /** Like query(), but yields to the browser every `chunkSize` rows so the UI stays responsive. */
  private async queryAsync<T>(
    sql: string,
    params: unknown[],
    mapRow: (row: Row) => T,
    chunkSize = 1000,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params as (string | number | null | Uint8Array)[]);
    const results: T[] = [];
    try {
      let i = 0;
      while (stmt.step()) {
        results.push(mapRow(stmt.getAsObject()));
        if (++i % chunkSize === 0) {
          onProgress?.(i, -1);
          await yieldToEventLoop();
          if (signal?.aborted) return results;
        }
      }
      onProgress?.(results.length, results.length);
    } finally {
      stmt.free();
    }
    return results;
  }

  private queryChunked<T>(
    ids: unknown[],
    buildSql: (placeholders: string) => string,
    suffixParams: unknown[],
    mapper: (row: Row) => T,
  ): T[] {
    if (ids.length === 0) return [];
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += SQL_VAR_LIMIT) {
      const chunk = ids.slice(i, i + SQL_VAR_LIMIT);
      const ph = chunk.map(() => "?").join(", ");
      const params = [...chunk, ...suffixParams];
      results.push(...this.query(buildSql(ph), params, mapper));
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
      "SELECT code, asset_type, param, name, decimal_places, is_base, is_hidden FROM currency WHERE code = ?",
      [code],
      mapCurrency,
    );
  }

  private getAccountByFullName(fullName: string): Account | null {
    return this.queryOne(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE full_name = ?",
      [fullName],
      mapAccount,
    );
  }

  private getAccountById(id: string): Account | null {
    return this.queryOne(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE id = ?",
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
      "SELECT id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id FROM line_item WHERE journal_entry_id = ?",
      [entryId],
      mapLineItem,
    );
  }

  private sumLineItems(
    accountIds: string[],
    beforeDate?: string,
  ): CurrencyBalance[] {
    if (accountIds.length === 0) return [];

    const extraParams: unknown[] = beforeDate ? [beforeDate] : [];
    const rows = this.queryChunked(
      accountIds,
      (ph) => {
        let sql = `SELECT li.currency, li.amount FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id WHERE li.account_id IN (${ph})`;
        if (beforeDate) sql += " AND je.date < ?";
        return sql;
      },
      extraParams,
      (row) => ({
        currency: row.currency as string,
        amount: row.amount as string,
      }),
    );

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
  private async sumAllLineItemsByAccount(
    beforeDate?: string,
    signal?: AbortSignal,
  ): Promise<Map<string, CurrencyBalance[]>> {
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
      let i = 0;
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

        if (++i % 1000 === 0) {
          await yieldToEventLoop();
          if (signal?.aborted) return new Map();
        }
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
        `SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE id IN (${ph})`,
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
      "SELECT code, asset_type, param, name, decimal_places, is_base, is_hidden FROM currency ORDER BY code",
      [],
      mapCurrency,
    );
  }

  async createCurrency(currency: Currency): Promise<void> {
    // Auto-hide spam currencies (garbage codes from DeFi imports)
    const hidden = currency.is_hidden || isSpamCurrency(currency.code);
    try {
      this.run(
        "INSERT INTO currency (code, asset_type, param, name, decimal_places, is_base, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          currency.code,
          currency.asset_type ?? "",
          currency.param ?? "",
          currency.name,
          currency.decimal_places,
          currency.is_base ? 1 : 0,
          hidden ? 1 : 0,
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

  async setCurrencyAssetType(code: string, assetType: string, param?: string): Promise<void> {
    this.run(
      "UPDATE currency SET asset_type = ? WHERE code = ? AND asset_type = ? AND param = ?",
      [assetType, code, "", param ?? ""],
    );
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
      "INSERT OR IGNORE INTO currency_token_address (currency, asset_type, param, chain, contract_address) VALUES (?, ?, ?, ?, ?)",
      [currency, "", "", chain, contractAddress],
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
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account ORDER BY full_name",
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
        "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          account.opened_at ?? null,
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

  async unarchiveAccount(id: string): Promise<void> {
    const account = this.getAccountById(id);
    if (!account) throw new Error(`account ${id} not found`);
    this.run("UPDATE account SET is_archived = 0 WHERE id = ?", [id]);
    this.audit("unarchive", "account", id, account.full_name);
    this.scheduleSave();
  }

  async updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean; opened_at?: string | null }): Promise<void> {
    const account = this.getAccountById(id);
    if (!account) throw new Error(`account ${id} not found`);

    // Prevent editing root accounts (the 5 top-level type roots)
    if (account.parent_id === null) {
      throw new Error(`cannot edit root account "${account.full_name}"`);
    }

    if (updates.full_name !== undefined && updates.full_name !== account.full_name) {
      const newFullName = updates.full_name.trim();
      if (!newFullName || !newFullName.includes(":")) {
        throw new Error("full_name must contain at least two segments (e.g. Assets:Bank)");
      }

      // Validate type constraint: new path must start with same type prefix
      const oldType = inferAccountTypeFromPath(account.full_name);
      const newType = inferAccountTypeFromPath(newFullName);
      if (oldType !== newType) {
        const oldPrefix = account.full_name.split(":")[0];
        throw new Error(`cannot change account type: "${newFullName}" does not start with "${oldPrefix}:"`);
      }

      // Check for duplicate
      const existing = this.getAccountByFullName(newFullName);
      if (existing && existing.id !== id) {
        throw new Error(`account "${newFullName}" already exists`);
      }

      // Build a cache of all accounts for parent lookups
      const accountByFullName = new Map<string, Account>();
      for (const a of await this.listAccounts()) {
        accountByFullName.set(a.full_name, a);
      }

      // Ensure parent hierarchy exists for newFullName
      const parts = newFullName.split(":");
      let parentId: string | null = null;
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join(":");
        const existingParent = accountByFullName.get(path);
        if (existingParent) {
          parentId = existingParent.id;
          continue;
        }
        // Create intermediate account
        const intermediateId = uuidv7();
        const accountType = inferAccountTypeFromPath(path);
        const intermediate: Account = {
          id: intermediateId,
          parent_id: parentId,
          account_type: accountType,
          name: parts[i - 1],
          full_name: path,
          allowed_currencies: [],
          is_postable: false,
          is_archived: false,
          created_at: new Date().toISOString().slice(0, 10),
        };
        this.run(
          "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [intermediate.id, intermediate.parent_id, intermediate.account_type, intermediate.name, intermediate.full_name, "[]", 0, 0, intermediate.created_at, null],
        );
        this.insertClosureEntries(intermediate.id, intermediate.parent_id);
        accountByFullName.set(path, intermediate);
        parentId = intermediateId;
      }

      const newName = parts[parts.length - 1];

      // Update the account itself
      this.run(
        "UPDATE account SET full_name = ?, name = ?, parent_id = ? WHERE id = ?",
        [newFullName, newName, parentId, id],
      );

      // Rebuild closure table entries for this account
      this.run("DELETE FROM account_closure WHERE descendant_id = ? AND ancestor_id != ?", [id, id]);
      if (parentId) {
        this.run(
          "INSERT INTO account_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM account_closure WHERE descendant_id = ?",
          [id, parentId],
        );
      }

      accountByFullName.delete(account.full_name);
      accountByFullName.set(newFullName, { ...account, full_name: newFullName, name: newName, parent_id: parentId });

      // Rename all descendant accounts
      const oldPrefix = account.full_name + ":";
      const descendants = this.query(
        "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE full_name LIKE ? ORDER BY length(full_name), full_name",
        [`${account.full_name}:%`],
        mapAccount,
      );

      for (const desc of descendants) {
        const descNewFullName = newFullName + desc.full_name.substring(account.full_name.length);
        const descParts = descNewFullName.split(":");
        const descNewName = descParts[descParts.length - 1];

        // Determine parent: the path one level up
        const descParentPath = descParts.slice(0, -1).join(":");
        const descParent = accountByFullName.get(descParentPath);
        const descParentId = descParent?.id ?? null;

        this.run(
          "UPDATE account SET full_name = ?, name = ?, parent_id = ? WHERE id = ?",
          [descNewFullName, descNewName, descParentId, desc.id],
        );

        // Rebuild closure for descendant
        this.run("DELETE FROM account_closure WHERE descendant_id = ? AND ancestor_id != ?", [desc.id, desc.id]);
        if (descParentId) {
          this.run(
            "INSERT INTO account_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM account_closure WHERE descendant_id = ?",
            [desc.id, descParentId],
          );
        }

        accountByFullName.delete(desc.full_name);
        accountByFullName.set(descNewFullName, { ...desc, full_name: descNewFullName, name: descNewName, parent_id: descParentId });
      }

      // Clean up orphaned old intermediate accounts iteratively
      // (non-postable accounts with no children and no line items, deepest first)
      // Repeat until no more orphans found (deleting a leaf may orphan its parent)
      const typeRoot = account.full_name.split(":")[0];
      for (;;) {
        const orphans = this.query(
          `SELECT a.id, a.full_name FROM account a
           WHERE a.full_name LIKE ? AND a.is_postable = 0
           AND a.parent_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM account c WHERE c.parent_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM line_item li WHERE li.account_id = a.id)
           ORDER BY length(a.full_name) DESC`,
          [`${typeRoot}:%`],
          (row) => ({ id: row.id as string, full_name: row.full_name as string }),
        );
        if (orphans.length === 0) break;
        for (const orphan of orphans) {
          this.run("DELETE FROM account_closure WHERE ancestor_id = ? OR descendant_id = ?", [orphan.id, orphan.id]);
          this.run("DELETE FROM account_metadata WHERE account_id = ?", [orphan.id]);
          this.run("DELETE FROM account WHERE id = ?", [orphan.id]);
        }
      }

      this.audit("rename", "account", id, `${account.full_name} -> ${newFullName}`);
    }

    if (updates.is_postable !== undefined && updates.is_postable !== account.is_postable) {
      this.run("UPDATE account SET is_postable = ? WHERE id = ?", [updates.is_postable ? 1 : 0, id]);
      this.audit("update", "account", id, `is_postable: ${updates.is_postable}`);
    }

    if ("opened_at" in updates) {
      this.run("UPDATE account SET opened_at = ? WHERE id = ?", [updates.opened_at ?? null, id]);
      this.audit("update", "account", id, `opened_at: ${updates.opened_at ?? "null"}`);
    }

    this.scheduleSave();
  }

  async mergeAccounts(
    sourceId: string,
    targetId: string,
  ): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; templates: number; metadata: number }> {
    if (sourceId === targetId) throw new Error("cannot merge an account into itself");

    const source = this.getAccountById(sourceId);
    if (!source) throw new Error(`source account ${sourceId} not found`);
    const target = this.getAccountById(targetId);
    if (!target) throw new Error(`target account ${targetId} not found`);
    if (source.account_type !== target.account_type) {
      throw new Error(`cannot merge accounts of different types (${source.account_type} vs ${target.account_type})`);
    }
    if (source.parent_id === null) {
      throw new Error(`cannot merge root account "${source.full_name}"`);
    }

    const totals = { lineItems: 0, lots: 0, assertions: 0, reconciliations: 0, templates: 0, metadata: 0 };

    // Helper: move all data from one account to another and delete the source
    const mergeData = (srcId: string, tgtId: string): void => {
      // 1. line_items
      this.run("UPDATE line_item SET account_id = ? WHERE account_id = ?", [tgtId, srcId]);
      const liCount = this.query("SELECT changes() AS c", [], (r) => r.c as number)[0] ?? 0;
      totals.lineItems += liCount;

      // 2. lots
      this.run("UPDATE lot SET account_id = ? WHERE account_id = ?", [tgtId, srcId]);
      const lotCount = this.query("SELECT changes() AS c", [], (r) => r.c as number)[0] ?? 0;
      totals.lots += lotCount;

      // 3. balance_assertions
      this.run("UPDATE balance_assertion SET account_id = ? WHERE account_id = ?", [tgtId, srcId]);
      const baCount = this.query("SELECT changes() AS c", [], (r) => r.c as number)[0] ?? 0;
      totals.assertions += baCount;

      // 4. account_metadata (INSERT OR IGNORE so target wins on key conflict)
      this.run(
        "INSERT OR IGNORE INTO account_metadata (account_id, key, value) SELECT ?, key, value FROM account_metadata WHERE account_id = ?",
        [tgtId, srcId],
      );
      const mdCount = this.query("SELECT changes() AS c", [], (r) => r.c as number)[0] ?? 0;
      totals.metadata += mdCount;
      this.run("DELETE FROM account_metadata WHERE account_id = ?", [srcId]);

      // 5. reconciliations
      this.run("UPDATE reconciliation SET account_id = ? WHERE account_id = ?", [tgtId, srcId]);
      const recCount = this.query("SELECT changes() AS c", [], (r) => r.c as number)[0] ?? 0;
      totals.reconciliations += recCount;

      // 6. recurring_templates — update account_id refs inside line_items_json
      const templates = this.query(
        "SELECT id, line_items_json FROM recurring_template",
        [],
        (row) => ({ id: row.id as string, json: row.line_items_json as string }),
      );
      for (const tmpl of templates) {
        const items = JSON.parse(tmpl.json || "[]") as Array<{ account_id: string }>;
        let changed = false;
        for (const item of items) {
          if (item.account_id === srcId) {
            item.account_id = tgtId;
            changed = true;
          }
        }
        if (changed) {
          this.run("UPDATE recurring_template SET line_items_json = ? WHERE id = ?", [JSON.stringify(items), tmpl.id]);
          totals.templates++;
        }
      }

      // 7. Delete source from closure table and account table
      this.run("DELETE FROM account_closure WHERE ancestor_id = ? OR descendant_id = ?", [srcId, srcId]);
      this.run("DELETE FROM account WHERE id = ?", [srcId]);
    };

    // Handle descendants of source in two passes
    const descendants = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE full_name LIKE ? ORDER BY length(full_name), full_name",
      [`${source.full_name}:%`],
      mapAccount,
    );

    // Pass 1 (shallowest first): rename non-conflicting, collect conflicting pairs
    const toMerge: Array<{ srcId: string; tgtId: string }> = [];
    for (const desc of descendants) {
      const newFullName = target.full_name + desc.full_name.substring(source.full_name.length);
      const existing = this.getAccountByFullName(newFullName);

      if (existing) {
        // Conflict — will merge in pass 2. Re-parent children to existing target account.
        this.run("UPDATE account SET parent_id = ? WHERE parent_id = ?", [existing.id, desc.id]);
        toMerge.push({ srcId: desc.id, tgtId: existing.id });
      } else {
        // No conflict: rename descendant to live under target
        const parts = newFullName.split(":");
        const newName = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join(":");
        const parentAccount = this.getAccountByFullName(parentPath);
        const newParentId = parentAccount?.id ?? null;

        this.run(
          "UPDATE account SET full_name = ?, name = ?, parent_id = ? WHERE id = ?",
          [newFullName, newName, newParentId, desc.id],
        );

        // Rebuild closure table entries
        this.run("DELETE FROM account_closure WHERE descendant_id = ? AND ancestor_id != ?", [desc.id, desc.id]);
        if (newParentId) {
          this.run(
            "INSERT INTO account_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM account_closure WHERE descendant_id = ?",
            [desc.id, newParentId],
          );
        }
      }
    }

    // Pass 2 (deepest first): merge conflicting pairs now that children have been re-parented
    for (const pair of toMerge.reverse()) {
      mergeData(pair.srcId, pair.tgtId);
    }

    // Now source should have no children — merge source into target
    mergeData(sourceId, targetId);

    // Clean up orphaned intermediate parent accounts (same pattern as updateAccount)
    const typeRoot = source.full_name.split(":")[0];
    for (;;) {
      const orphans = this.query(
        `SELECT a.id, a.full_name FROM account a
         WHERE a.full_name LIKE ? AND a.is_postable = 0
         AND a.parent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM account c WHERE c.parent_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM line_item li WHERE li.account_id = a.id)
         ORDER BY length(a.full_name) DESC`,
        [`${typeRoot}:%`],
        (row) => ({ id: row.id as string, full_name: row.full_name as string }),
      );
      if (orphans.length === 0) break;
      for (const orphan of orphans) {
        this.run("DELETE FROM account_closure WHERE ancestor_id = ? OR descendant_id = ?", [orphan.id, orphan.id]);
        this.run("DELETE FROM account_metadata WHERE account_id = ?", [orphan.id]);
        this.run("DELETE FROM account WHERE id = ?", [orphan.id]);
      }
    }

    this.audit("merge", "account", sourceId, `${source.full_name} -> ${target.full_name}`);
    this.scheduleSave();
    return totals;
  }

  async renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }> {
    if (oldPrefix === newPrefix) return { renamed: 0, skipped: 0 };

    // 1. Find all accounts whose full_name starts with oldPrefix: or equals oldPrefix
    const allAccounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account WHERE full_name = ? OR full_name LIKE ? ORDER BY length(full_name), full_name",
      [oldPrefix, `${oldPrefix}:%`],
      mapAccount,
    );
    if (allAccounts.length === 0) return { renamed: 0, skipped: 0 };

    let renamed = 0;
    let skipped = 0;

    // Build a cache of all accounts for parent lookups
    const accountByFullName = new Map<string, Account>();
    for (const a of await this.listAccounts()) {
      accountByFullName.set(a.full_name, a);
    }

    for (const account of allAccounts) {
      const newFullName = newPrefix + account.full_name.substring(oldPrefix.length);

      // Skip if target already exists
      if (accountByFullName.has(newFullName)) {
        skipped++;
        continue;
      }

      // Ensure parent hierarchy exists for newFullName
      const parts = newFullName.split(":");
      let parentId: string | null = null;
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join(":");
        const existing = accountByFullName.get(path);
        if (existing) {
          parentId = existing.id;
          continue;
        }
        // Create intermediate account
        const intermediateId = uuidv7();
        const accountType = inferAccountTypeFromPath(path);
        const intermediate: Account = {
          id: intermediateId,
          parent_id: parentId,
          account_type: accountType,
          name: parts[i - 1],
          full_name: path,
          allowed_currencies: [],
          is_postable: false,
          is_archived: false,
          created_at: new Date().toISOString().slice(0, 10),
        };
        this.run(
          "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [intermediate.id, intermediate.parent_id, intermediate.account_type, intermediate.name, intermediate.full_name, "[]", 0, 0, intermediate.created_at, null],
        );
        this.insertClosureEntries(intermediate.id, intermediate.parent_id);
        accountByFullName.set(path, intermediate);
        parentId = intermediateId;
      }

      const newName = parts[parts.length - 1];
      const newAccountType = inferAccountTypeFromPath(newFullName);

      // Update the account record
      this.run(
        "UPDATE account SET full_name = ?, name = ?, parent_id = ?, account_type = ? WHERE id = ?",
        [newFullName, newName, parentId, newAccountType, account.id],
      );

      // Rebuild closure table entries for this account
      this.run(
        "DELETE FROM account_closure WHERE descendant_id = ? AND ancestor_id != ?",
        [account.id, account.id],
      );
      if (parentId) {
        this.run(
          "INSERT INTO account_closure (ancestor_id, descendant_id, depth) SELECT ancestor_id, ?, depth + 1 FROM account_closure WHERE descendant_id = ?",
          [account.id, parentId],
        );
      }

      // Update cache
      accountByFullName.delete(account.full_name);
      accountByFullName.set(newFullName, { ...account, full_name: newFullName, name: newName, parent_id: parentId, account_type: newAccountType });

      this.audit("rename", "account", account.id, `${account.full_name} -> ${newFullName}`);
      renamed++;
    }

    // Clean up orphaned intermediate accounts under the old prefix
    // (accounts that now have no children and no line items)
    const oldIntermediates = this.query(
      `SELECT a.id, a.full_name FROM account a
       WHERE (a.full_name = ? OR a.full_name LIKE ?)
       AND a.is_postable = 0
       AND NOT EXISTS (SELECT 1 FROM account c WHERE c.parent_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM line_item li WHERE li.account_id = a.id)`,
      [oldPrefix, `${oldPrefix}:%`],
      (row) => ({ id: row.id as string, full_name: row.full_name as string }),
    );
    // Delete from deepest to shallowest
    oldIntermediates.sort((a, b) => b.full_name.length - a.full_name.length);
    for (const orphan of oldIntermediates) {
      this.run("DELETE FROM account_closure WHERE ancestor_id = ? OR descendant_id = ?", [orphan.id, orphan.id]);
      this.run("DELETE FROM account_metadata WHERE account_id = ?", [orphan.id]);
      this.run("DELETE FROM account WHERE id = ?", [orphan.id]);
    }

    this.scheduleSave();
    return { renamed, skipped };
  }

  // ---- Backend: Journal entries ----

  async postJournalEntry(
    entry: JournalEntry,
    items: LineItem[],
  ): Promise<void> {
    this.validateJournalEntry(items);
    this.run(
      "INSERT INTO journal_entry (id, date, description, description_data, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        entry.id,
        entry.date,
        entry.description,
        entry.description_data ?? null,
        entry.status,
        entry.source,
        entry.voided_by,
        entry.created_at,
      ],
    );
    for (const item of items) {
      this.run(
        "INSERT INTO line_item (id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          item.id,
          item.journal_entry_id,
          item.account_id,
          item.currency,
          item.currency_asset_type ?? "",
          item.currency_param ?? "",
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
      "SELECT id, date, description, description_data, status, source, voided_by, created_at FROM journal_entry WHERE id = ?",
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
      description_data: JSON.stringify({ type: "system", action: "reversal", ref: id }),
      status: "confirmed",
      source: "system:void",
      voided_by: null,
      created_at: today,
    };

    this.run(
      "INSERT INTO journal_entry (id, date, description, description_data, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        reversal.id,
        reversal.date,
        reversal.description,
        reversal.description_data ?? null,
        reversal.status,
        reversal.source,
        null,
        reversal.created_at,
      ],
    );

    for (const item of items) {
      const negAmount = new Decimal(item.amount).neg().toString();
      this.run(
        "INSERT INTO line_item (id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [uuidv7(), reversalId, item.account_id, item.currency, item.currency_asset_type ?? "", item.currency_param ?? "", negAmount, null],
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

  async editJournalEntry(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string }> {
    // 1. Validate original exists and is not voided
    const original = this.queryOne(
      "SELECT id, date, description, description_data, status, source, voided_by, created_at FROM journal_entry WHERE id = ?",
      [originalId],
      mapJournalEntry,
    );
    if (!original) throw new Error(`journal entry ${originalId} not found`);
    if (original.status === "voided")
      throw new Error(`journal entry ${originalId} is already voided`);

    // 2. Check no line items are reconciled
    const reconciledCount = this.queryOne(
      "SELECT COUNT(*) as cnt FROM line_item WHERE journal_entry_id = ? AND is_reconciled = 1",
      [originalId],
      (row) => row.cnt as number,
    );
    if (reconciledCount && reconciledCount > 0) {
      throw new Error(`cannot edit entry ${originalId}: has reconciled line items`);
    }

    // 3. Validate new entry balances
    this.validateJournalEntry(newItems);

    // 4. Wrap in transaction
    const wasInTransaction = this.inTransaction;
    if (!wasInTransaction) this.beginTransaction();
    try {
      // 5. Inline void logic (same as voidJournalEntry but within the transaction)
      const originalItems = this.fetchLineItemsForEntry(originalId);
      const reversalId = uuidv7();
      const today = this.today();

      const reversal: JournalEntry = {
        id: reversalId,
        date: today,
        description: `Reversal of: ${original.description}`,
        description_data: JSON.stringify({ type: "system", action: "reversal", ref: originalId }),
        status: "confirmed",
        source: "system:void",
        voided_by: null,
        created_at: today,
      };

      this.run(
        "INSERT INTO journal_entry (id, date, description, description_data, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [reversal.id, reversal.date, reversal.description, reversal.description_data ?? null, reversal.status, reversal.source, null, reversal.created_at],
      );

      for (const item of originalItems) {
        const negAmount = new Decimal(item.amount).neg().toString();
        this.run(
          "INSERT INTO line_item (id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [uuidv7(), reversalId, item.account_id, item.currency, item.currency_asset_type ?? "", item.currency_param ?? "", negAmount, null],
        );
      }

      this.run(
        "UPDATE journal_entry SET status = 'voided', voided_by = ? WHERE id = ?",
        [reversalId, originalId],
      );

      // 6. Post the new entry
      this.run(
        "INSERT INTO journal_entry (id, date, description, description_data, status, source, voided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [newEntry.id, newEntry.date, newEntry.description, newEntry.description_data ?? null, newEntry.status, newEntry.source, newEntry.voided_by, newEntry.created_at],
      );

      for (const item of newItems) {
        this.run(
          "INSERT INTO line_item (id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [item.id, item.journal_entry_id, item.account_id, item.currency, item.currency_asset_type ?? "", item.currency_param ?? "", item.amount, item.lot_id],
        );
      }

      // 7. Transfer metadata: copy original's, overlay with newMetadata, add edit provenance
      const originalMeta = await this.getMetadata(originalId);
      const mergedMeta: Record<string, string> = {
        ...originalMeta,
        ...(newMetadata ?? {}),
        "edit:original_id": originalId,
        "edit:edited_at": today,
      };
      for (const [key, value] of Object.entries(mergedMeta)) {
        this.run(
          "INSERT OR REPLACE INTO journal_entry_metadata (journal_entry_id, key, value) VALUES (?, ?, ?)",
          [newEntry.id, key, value],
        );
      }

      // 8. Transfer links: use newLinks if provided, else copy original's
      const linksToSet = newLinks ?? await this.getEntryLinks(originalId);
      if (linksToSet.length > 0) {
        for (const link of linksToSet) {
          const normalized = link.trim().toLowerCase();
          if (normalized) {
            this.run(
              "INSERT OR IGNORE INTO entry_link (journal_entry_id, link_name) VALUES (?, ?)",
              [newEntry.id, normalized],
            );
          }
        }
      }

      // 9. Audit both operations
      this.audit("void", "journal_entry", originalId, `reversed by ${reversalId} (edit)`);
      this.audit("post", "journal_entry", newEntry.id, `edit of ${originalId}: ${newEntry.description}`);

      if (!wasInTransaction) this.commitTransaction();
      this.scheduleSave();
      return { reversalId, newEntryId: newEntry.id };
    } catch (e) {
      if (!wasInTransaction) this.rollbackTransaction();
      throw e;
    }
  }

  async getJournalEntry(
    id: string,
  ): Promise<[JournalEntry, LineItem[]] | null> {
    const entry = this.queryOne(
      "SELECT id, date, description, description_data, status, source, voided_by, created_at FROM journal_entry WHERE id = ?",
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
      "SELECT DISTINCT je.id, je.date, je.description, je.description_data, je.status, je.source, je.voided_by, je.created_at FROM journal_entry je";
    const conditions: string[] = [];
    const params: unknown[] = [];

    // account_ids takes precedence over account_id when both set
    // Use account_closure to include sub-account transactions
    if (filter.account_ids && filter.account_ids.length > 0) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      const placeholders = filter.account_ids.map(() => "?").join(", ");
      conditions.push(`li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id IN (${placeholders}))`);
      params.push(...filter.account_ids);
    } else if (filter.account_id) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      conditions.push("li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id = ?)");
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
    if (filter.tag_filters && filter.tag_filters.length > 0) {
      for (const tag of filter.tag_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (',' || LOWER(value) || ',') LIKE ?)",
        );
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.tag_filters_or && filter.tag_filters_or.length > 0) {
      const orParts = filter.tag_filters_or.map(() =>
        "(',' || LOWER(value) || ',') LIKE ?"
      );
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (${orParts.join(" OR ")}))`
      );
      for (const tag of filter.tag_filters_or) {
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.link_filters && filter.link_filters.length > 0) {
      for (const link of filter.link_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM entry_link WHERE link_name = ?)",
        );
        params.push(link.toLowerCase());
      }
    }
    if (filter.link_filters_or && filter.link_filters_or.length > 0) {
      const orParts = filter.link_filters_or.map(() => "link_name = ?");
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM entry_link WHERE ${orParts.join(" OR ")})`,
      );
      for (const link of filter.link_filters_or) {
        params.push(link.toLowerCase());
      }
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    const allowedColumns: Record<string, string> = {
      date: "je.date",
      description: "je.description",
      status: "je.status",
    };
    const col = filter.order_by && allowedColumns[filter.order_by];
    const dir = filter.order_direction === "asc" ? "ASC" : "DESC";
    if (col) {
      sql += ` ORDER BY ${col} ${dir}, je.created_at ${dir}`;
    } else {
      sql += " ORDER BY je.date DESC, je.created_at DESC";
    }
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

    // Batch: one query for ALL line items instead of N+1 (chunked to avoid SQL variable limit)
    const entryIds = entries.map((e) => e.id);
    const allItems = this.queryChunked(
      entryIds,
      (ph) => `SELECT id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id
       FROM line_item WHERE journal_entry_id IN (${ph})`,
      [],
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

  private buildFilterSql(filter: TransactionFilter): { joinClause: string; whereClause: string; params: unknown[] } {
    let joinClause = "";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.account_ids && filter.account_ids.length > 0) {
      joinClause = " JOIN line_item li ON li.journal_entry_id = je.id";
      const placeholders = filter.account_ids.map(() => "?").join(", ");
      conditions.push(`li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id IN (${placeholders}))`);
      params.push(...filter.account_ids);
    } else if (filter.account_id) {
      joinClause = " JOIN line_item li ON li.journal_entry_id = je.id";
      conditions.push("li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id = ?)");
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
    if (filter.tag_filters && filter.tag_filters.length > 0) {
      for (const tag of filter.tag_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (',' || LOWER(value) || ',') LIKE ?)",
        );
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.tag_filters_or && filter.tag_filters_or.length > 0) {
      const orParts = filter.tag_filters_or.map(() =>
        "(',' || LOWER(value) || ',') LIKE ?"
      );
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (${orParts.join(" OR ")}))`
      );
      for (const tag of filter.tag_filters_or) {
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.link_filters && filter.link_filters.length > 0) {
      for (const link of filter.link_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM entry_link WHERE link_name = ?)",
        );
        params.push(link.toLowerCase());
      }
    }
    if (filter.link_filters_or && filter.link_filters_or.length > 0) {
      const orParts = filter.link_filters_or.map(() => "link_name = ?");
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM entry_link WHERE ${orParts.join(" OR ")})`,
      );
      for (const link of filter.link_filters_or) {
        params.push(link.toLowerCase());
      }
    }
    if (filter.exclude_hidden_currencies) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM line_item li_hc WHERE li_hc.journal_entry_id = je.id AND li_hc.currency IN (SELECT code FROM currency WHERE is_hidden = 1))"
      );
    }
    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    return { joinClause, whereClause, params };
  }

  async queryJournalEntriesOnly(
    filter: TransactionFilter,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<JournalEntry[]> {
    const { joinClause, whereClause, params } = this.buildFilterSql(filter);
    let sql = "SELECT DISTINCT je.id, je.date, je.description, je.description_data, je.status, je.source, je.voided_by, je.created_at FROM journal_entry je"
      + joinClause + whereClause;

    const allowedColumns: Record<string, string> = {
      date: "je.date",
      description: "je.description",
      status: "je.status",
    };
    const col = filter.order_by && allowedColumns[filter.order_by];
    const dir = filter.order_direction === "asc" ? "ASC" : "DESC";
    if (col) {
      sql += ` ORDER BY ${col} ${dir}, je.created_at ${dir}`;
    } else {
      sql += " ORDER BY je.date DESC, je.created_at DESC";
    }
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    if (filter.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(filter.offset);
    }

    const total = onProgress ? await this.countJournalEntries(filter) : 0;
    return this.queryAsync(sql, params, mapJournalEntry, 1000,
      onProgress ? (current) => onProgress(current, total) : undefined,
      signal);
  }

  async getLineItemsForEntries(entryIds: string[]): Promise<Map<string, LineItem[]>> {
    const result = new Map<string, LineItem[]>();
    if (entryIds.length === 0) return result;
    const allItems = this.queryChunked(
      entryIds,
      (ph) => `SELECT id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id
       FROM line_item WHERE journal_entry_id IN (${ph})`,
      [],
      mapLineItem,
    );
    for (const item of allItems) {
      let list = result.get(item.journal_entry_id);
      if (!list) {
        list = [];
        result.set(item.journal_entry_id, list);
      }
      list.push(item);
    }
    return result;
  }

  async getJournalChartAggregation(
    filter: TransactionFilter,
  ): Promise<{ date: string; income: number; expense: number }[]> {
    const { joinClause: filterJoin, whereClause, params } = this.buildFilterSql(filter);
    // We always need the line_item + account join for aggregation
    // If filterJoin already has a li join, use it; otherwise add our own
    const needsLiJoin = !filterJoin.includes("line_item");
    const liJoin = needsLiJoin ? " JOIN line_item li ON li.journal_entry_id = je.id" : "";
    const sql = `SELECT je.date,
      SUM(CASE WHEN a.full_name LIKE 'Income:%' OR a.full_name = 'Income'
        THEN ABS(CAST(li.amount AS REAL)) ELSE 0 END) as income,
      SUM(CASE WHEN a.full_name LIKE 'Expenses:%' OR a.full_name = 'Expenses'
        THEN ABS(CAST(li.amount AS REAL)) ELSE 0 END) as expense
      FROM journal_entry je${filterJoin}${liJoin}
      JOIN account a ON a.id = li.account_id
      ${whereClause ? whereClause + " AND je.status != 'voided'" : "WHERE je.status != 'voided'"}
      GROUP BY je.date ORDER BY je.date`;

    return this.query(sql, params, (row) => ({
      date: row.date as string,
      income: (row.income as number) || 0,
      expense: (row.expense as number) || 0,
    }));
  }

  async countJournalEntries(
    filter: TransactionFilter,
  ): Promise<number> {
    let sql =
      "SELECT COUNT(DISTINCT je.id) as cnt FROM journal_entry je";
    const conditions: string[] = [];
    const params: unknown[] = [];

    // account_ids takes precedence over account_id when both set
    // Use account_closure to include sub-account transactions
    if (filter.account_ids && filter.account_ids.length > 0) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      const placeholders = filter.account_ids.map(() => "?").join(", ");
      conditions.push(`li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id IN (${placeholders}))`);
      params.push(...filter.account_ids);
    } else if (filter.account_id) {
      sql += " JOIN line_item li ON li.journal_entry_id = je.id";
      conditions.push("li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id = ?)");
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
    if (filter.tag_filters && filter.tag_filters.length > 0) {
      for (const tag of filter.tag_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (',' || LOWER(value) || ',') LIKE ?)",
        );
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.tag_filters_or && filter.tag_filters_or.length > 0) {
      const orParts = filter.tag_filters_or.map(() =>
        "(',' || LOWER(value) || ',') LIKE ?"
      );
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (${orParts.join(" OR ")}))`
      );
      for (const tag of filter.tag_filters_or) {
        params.push(`%,${tag.toLowerCase()},%`);
      }
    }
    if (filter.link_filters && filter.link_filters.length > 0) {
      for (const link of filter.link_filters) {
        conditions.push(
          "je.id IN (SELECT journal_entry_id FROM entry_link WHERE link_name = ?)",
        );
        params.push(link.toLowerCase());
      }
    }
    if (filter.link_filters_or && filter.link_filters_or.length > 0) {
      const orParts = filter.link_filters_or.map(() => "link_name = ?");
      conditions.push(
        `je.id IN (SELECT journal_entry_id FROM entry_link WHERE ${orParts.join(" OR ")})`,
      );
      for (const link of filter.link_filters_or) {
        params.push(link.toLowerCase());
      }
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
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const allBalances = await this.sumAllLineItemsByAccount(asOf);
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
  private async sumAllLineItemsByAccountDual(
    date1: string,
    date2: string,
    signal?: AbortSignal,
  ): Promise<[Map<string, CurrencyBalance[]>, Map<string, CurrencyBalance[]>]> {
    const [earlier, later] = date1 < date2 ? [date1, date2] : [date2, date1];

    const sql =
      "SELECT li.account_id, li.currency, li.amount, je.date FROM line_item li JOIN journal_entry je ON je.id = li.journal_entry_id WHERE je.date < ? ORDER BY je.date ASC";
    const stmt = this.db.prepare(sql);
    stmt.bind([later]);

    const running = new Map<string, Map<string, Decimal>>();
    let snapshotAtEarlier: Map<string, Map<string, Decimal>> | null = null;
    let passedEarlier = false;

    try {
      let i = 0;
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

        if (++i % 1000 === 0) {
          await yieldToEventLoop();
          if (signal?.aborted) return [new Map(), new Map()];
        }
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
    signal?: AbortSignal,
  ): Promise<IncomeStatement> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const [allBalancesStart, allBalancesEnd] = await this.sumAllLineItemsByAccountDual(fromDate, toDate, signal);
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

  async balanceSheet(asOf: string, signal?: AbortSignal): Promise<BalanceSheet> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

    const allBalances = await this.sumAllLineItemsByAccount(asOf, signal);
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

  async balanceSheetBatch(dates: string[], signal?: AbortSignal): Promise<Map<string, BalanceSheet>> {
    if (dates.length === 0) return new Map();

    // Single-pass: query accounts once, scan line_items once up to max date
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at FROM account ORDER BY full_name",
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
      let i = 0;
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

        if (++i % 1000 === 0) {
          await yieldToEventLoop();
          if (signal?.aborted) return new Map();
        }
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

    // Batch: fetch all lots at once (chunked to avoid SQL variable limit)
    const uniqueLotIds = [...new Set(disposals.map((d) => d.lot_id))];
    const lotMap = new Map<string, { currency: string; acquired_date: string; cost_basis_per_unit: string; source_handler: string | null }>();
    if (uniqueLotIds.length > 0) {
      const lots = this.queryChunked(
        uniqueLotIds,
        (ph) => `SELECT id, currency, acquired_date, cost_basis_per_unit,
                (SELECT m.value FROM journal_entry_metadata m
                 WHERE m.journal_entry_id = lot.journal_entry_id AND m.key = 'handler') as source_handler
         FROM lot WHERE id IN (${ph})`,
        [],
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
      `INSERT INTO budget (id, account_pattern, period_type, amount, currency, currency_asset_type, currency_param, start_date, end_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [budget.id, budget.account_pattern, budget.period_type, budget.amount, budget.currency, budget.currency_asset_type ?? "", budget.currency_param ?? "", budget.start_date, budget.end_date],
    );
    this.scheduleSave();
  }

  async listBudgets(): Promise<Budget[]> {
    return this.query(
      "SELECT id, account_pattern, period_type, amount, currency, currency_asset_type, currency_param, start_date, end_date, created_at FROM budget ORDER BY account_pattern",
      [],
      (row) => ({
        id: row.id as string,
        account_pattern: row.account_pattern as string,
        period_type: row.period_type as "monthly" | "yearly",
        amount: row.amount as string,
        currency: row.currency as string,
        currency_asset_type: (row.currency_asset_type as string) ?? "",
        currency_param: (row.currency_param as string) ?? "",
        start_date: (row.start_date as string) || null,
        end_date: (row.end_date as string) || null,
        created_at: row.created_at as string,
      }),
    );
  }

  async updateBudget(budget: Budget): Promise<void> {
    this.run(
      `UPDATE budget SET account_pattern = ?, period_type = ?, amount = ?, currency = ?, currency_asset_type = ?, currency_param = ?, start_date = ?, end_date = ? WHERE id = ?`,
      [budget.account_pattern, budget.period_type, budget.amount, budget.currency, budget.currency_asset_type ?? "", budget.currency_param ?? "", budget.start_date, budget.end_date, budget.id],
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
      "INSERT INTO exchange_rate (id, date, from_currency, from_currency_asset_type, from_currency_param, to_currency, to_currency_asset_type, to_currency_param, rate, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        rate.id,
        rate.date,
        rate.from_currency,
        rate.from_currency_asset_type ?? "",
        rate.from_currency_param ?? "",
        rate.to_currency,
        rate.to_currency_asset_type ?? "",
        rate.to_currency_param ?? "",
        rate.rate,
        rate.source,
      ],
    );
    this.scheduleSave();
  }

  async recordExchangeRateBatch(rates: ExchangeRate[]): Promise<void> {
    if (rates.length === 0) return;

    // Fetch existing sources for all (date, from, to) tuples, chunked to stay under SQL variable limit
    const keys = rates.map((r) => `${r.date}|${r.from_currency}|${r.to_currency}`);
    const uniqueKeys = [...new Set(keys)];

    const existingSources = new Map<string, string>();
    const chunkSize = Math.floor(SQL_VAR_LIMIT / 3); // 3 vars per key
    for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
      const chunk = uniqueKeys.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
      const params: unknown[] = [];
      for (const key of chunk) {
        const [date, from, to] = key.split("|");
        params.push(date, from, to);
      }
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
          "INSERT INTO exchange_rate (id, date, from_currency, from_currency_asset_type, from_currency_param, to_currency, to_currency_asset_type, to_currency_param, rate, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [rate.id, rate.date, rate.from_currency, rate.from_currency_asset_type ?? "", rate.from_currency_param ?? "", rate.to_currency, rate.to_currency_asset_type ?? "", rate.to_currency_param ?? "", rate.rate, rate.source],
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

    // Transitive fallback: A→X→B via single intermediate
    // Both legs use "on or before" matching within a 7-day staleness window
    const TRANSITIVE_MAX_STALENESS_DAYS = 7;
    const targetDate = new Date(date);
    const windowStart = new Date(targetDate);
    windowStart.setDate(windowStart.getDate() - TRANSITIVE_MAX_STALENESS_DAYS);
    const windowStartStr = windowStart.toISOString().slice(0, 10);

    // Collect latest first-leg rate per intermediate currency (deduplicated)
    const fromLegs = new Map<string, { rate: Decimal; date: string }>();

    // Direct: from→X (latest within window)
    const directLegs = this.query(
      "SELECT to_currency, rate, date FROM exchange_rate WHERE from_currency = ? AND date <= ? AND date >= ? ORDER BY date DESC",
      [from, date, windowStartStr],
      (row) => ({ currency: row.to_currency as string, rate: row.rate as string, date: row.date as string }),
    );
    for (const r of directLegs) {
      if (!fromLegs.has(r.currency)) {
        fromLegs.set(r.currency, { rate: new Decimal(r.rate), date: r.date });
      }
    }

    // Inverse: X→from (so from→X = 1/rate), latest within window
    const inverseLegs = this.query(
      "SELECT from_currency, rate, date FROM exchange_rate WHERE to_currency = ? AND date <= ? AND date >= ? ORDER BY date DESC",
      [from, date, windowStartStr],
      (row) => ({ currency: row.from_currency as string, rate: row.rate as string, date: row.date as string }),
    );
    for (const r of inverseLegs) {
      const d = new Decimal(r.rate);
      if (d.isZero()) continue;
      if (!fromLegs.has(r.currency)) {
        fromLegs.set(r.currency, { rate: new Decimal(1).div(d), date: r.date });
      }
    }

    // For each intermediate X, find latest X→to (or to→X) within staleness window
    for (const [x, leg] of fromLegs) {
      // Direct: X→to
      const xToDirect = this.queryOne(
        "SELECT rate FROM exchange_rate WHERE from_currency = ? AND to_currency = ? AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 1",
        [x, to, date, windowStartStr],
        (row) => row.rate as string,
      );
      if (xToDirect !== null) {
        return leg.rate.times(new Decimal(xToDirect)).toString();
      }

      // Inverse: to→X (so X→to = 1/rate)
      const xToInverse = this.queryOne(
        "SELECT rate FROM exchange_rate WHERE from_currency = ? AND to_currency = ? AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 1",
        [to, x, date, windowStartStr],
        (row) => row.rate as string,
      );
      if (xToInverse !== null) {
        const inv = new Decimal(xToInverse);
        if (!inv.isZero()) {
          return leg.rate.times(new Decimal(1).div(inv)).toString();
        }
      }
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

    // Fetch all rates for these currencies to/from baseCurrency, chunked to stay under SQL variable limit
    const rateIndex = new Map<string, string[]>();
    const currChunkSize = SQL_VAR_LIMIT - 1; // reserve 1 var for baseCurrency
    for (let i = 0; i < currencies.length; i += currChunkSize) {
      const chunk = currencies.slice(i, i + currChunkSize);
      const ph = chunk.map(() => "?").join(", ");

      // Direct: from_currency IN chunk, to_currency = baseCurrency
      const directRows = this.query(
        `SELECT from_currency, date FROM exchange_rate WHERE from_currency IN (${ph}) AND to_currency = ?`,
        [...chunk, baseCurrency],
        (row) => ({ currency: row.from_currency as string, date: row.date as string }),
      );

      // Inverse: from_currency = baseCurrency, to_currency IN chunk
      const inverseRows = this.query(
        `SELECT to_currency AS currency, date FROM exchange_rate WHERE from_currency = ? AND to_currency IN (${ph})`,
        [baseCurrency, ...chunk],
        (row) => ({ currency: row.currency as string, date: row.date as string }),
      );

      for (const row of [...directRows, ...inverseRows]) {
        let dates = rateIndex.get(row.currency);
        if (!dates) {
          dates = [];
          rateIndex.set(row.currency, dates);
        }
        dates.push(row.date);
      }
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

  async getExchangeRatesBatchExact(
    pairs: { currency: string; date: string }[],
    baseCurrency: string,
  ): Promise<Map<string, boolean>> {
    if (pairs.length === 0) return new Map();

    // Collect unique currencies
    const currencies = [...new Set(pairs.map((p) => p.currency))];
    if (currencies.length === 0) return new Map();

    // Fetch rates chunked to stay under SQL variable limit
    const exactSet = new Set<string>();
    const exactChunkSize = SQL_VAR_LIMIT - 1; // reserve 1 var for baseCurrency
    for (let i = 0; i < currencies.length; i += exactChunkSize) {
      const chunk = currencies.slice(i, i + exactChunkSize);
      const ph = chunk.map(() => "?").join(", ");

      // Direct: from_currency IN chunk, to_currency = baseCurrency
      const directRows = this.query(
        `SELECT from_currency, date FROM exchange_rate WHERE from_currency IN (${ph}) AND to_currency = ?`,
        [...chunk, baseCurrency],
        (row) => ({ currency: row.from_currency as string, date: row.date as string }),
      );

      // Inverse: from_currency = baseCurrency, to_currency IN chunk
      const inverseRows = this.query(
        `SELECT to_currency AS currency, date FROM exchange_rate WHERE from_currency = ? AND to_currency IN (${ph})`,
        [baseCurrency, ...chunk],
        (row) => ({ currency: row.currency as string, date: row.date as string }),
      );

      for (const row of [...directRows, ...inverseRows]) {
        exactSet.add(`${row.currency}:${row.date}`);
      }
    }

    // For each pair, check exact match only
    const result = new Map<string, boolean>();
    for (const { currency, date } of pairs) {
      const key = `${currency}:${date}`;
      result.set(key, exactSet.has(key));
    }

    return result;
  }

  async getExchangeRateCurrenciesOnDate(date: string): Promise<string[]> {
    return this.query(
      "SELECT DISTINCT from_currency FROM exchange_rate WHERE date = ?",
      [date],
      (row) => row.from_currency as string,
    );
  }

  async getCurrencyDateRequirements(baseCurrency: string): Promise<import("./backend.js").CurrencyDateRequirement[]> {
    const rows = this.query(
      `SELECT li.currency, a.account_type,
              MIN(je.date) AS first_date, MAX(je.date) AS last_date,
              SUM(CAST(li.amount AS REAL)) AS balance,
              GROUP_CONCAT(DISTINCT je.date) AS all_dates
       FROM line_item li
       JOIN journal_entry je ON je.id = li.journal_entry_id
       JOIN account a ON a.id = li.account_id
       WHERE je.status != 'voided' AND li.currency != ?
       GROUP BY li.currency, a.account_type`,
      [baseCurrency],
      (row) => ({
        currency: row.currency as string,
        accountType: row.account_type as string,
        firstDate: row.first_date as string,
        lastDate: row.last_date as string,
        balance: row.balance as number,
        allDates: row.all_dates as string,
      }),
    );

    // Merge rows per currency: asset/liability → range, others → dates
    // If a currency appears in both asset and expense, range dominates
    const currencyMap = new Map<string, {
      hasRange: boolean;
      firstDate: string;
      lastDate: string;
      balanceSum: number;
      allDates: Set<string>;
    }>();

    for (const row of rows) {
      const isRange = row.accountType === "asset" || row.accountType === "liability";
      let entry = currencyMap.get(row.currency);
      if (!entry) {
        entry = {
          hasRange: false,
          firstDate: row.firstDate,
          lastDate: row.lastDate,
          balanceSum: 0,
          allDates: new Set(),
        };
        currencyMap.set(row.currency, entry);
      }

      if (isRange) {
        entry.hasRange = true;
        entry.balanceSum += row.balance;
      }

      // Extend date range
      if (row.firstDate < entry.firstDate) entry.firstDate = row.firstDate;
      if (row.lastDate > entry.lastDate) entry.lastDate = row.lastDate;

      // Collect all dates
      if (row.allDates) {
        for (const d of row.allDates.split(",")) {
          entry.allDates.add(d);
        }
      }
    }

    const results: import("./backend.js").CurrencyDateRequirement[] = [];
    for (const [currency, entry] of currencyMap) {
      if (entry.hasRange) {
        results.push({
          currency,
          mode: "range",
          firstDate: entry.firstDate,
          lastDate: entry.lastDate,
          hasBalance: Math.abs(entry.balanceSum) > 1e-12,
          dates: [],
        });
      } else {
        const sortedDates = [...entry.allDates].sort();
        results.push({
          currency,
          mode: "dates",
          firstDate: sortedDates[0],
          lastDate: sortedDates[sortedDates.length - 1],
          hasBalance: false,
          dates: sortedDates,
        });
      }
    }

    return results;
  }

  async listExchangeRates(
    from?: string,
    to?: string,
  ): Promise<ExchangeRate[]> {
    let sql =
      "SELECT id, date, from_currency, from_currency_asset_type, from_currency_param, to_currency, to_currency_asset_type, to_currency_param, rate, source FROM exchange_rate";
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

  async importLedgerFile(content: string, format?: import("./ledger-format.js").LedgerFormat, options?: import("./browser-ledger-file.js").LedgerImportOptions): Promise<LedgerImportResult> {
    const { importLedger } = await import("./browser-ledger-file.js");
    this.beginTransaction();
    try {
      const result = await importLedger(this, content, format, options);
      this.commitTransaction();
      return result;
    } catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  }

  async exportLedgerFile(format?: import("./ledger-format.js").LedgerFormat): Promise<string> {
    const { exportLedger } = await import("./browser-ledger-file.js");
    return exportLedger(this, format);
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

  async getMetadataBatch(entryIds: string[]): Promise<Map<string, Record<string, string>>> {
    const result = new Map<string, Record<string, string>>();
    if (entryIds.length === 0) return result;
    const rows = this.queryChunked(
      entryIds,
      (ph) => `SELECT journal_entry_id, key, value FROM journal_entry_metadata WHERE journal_entry_id IN (${ph}) ORDER BY key`,
      [],
      (row) => ({ id: row.journal_entry_id as string, key: row.key as string, value: row.value as string }),
    );
    for (const { id, key, value } of rows) {
      let rec = result.get(id);
      if (!rec) {
        rec = {};
        result.set(id, rec);
      }
      rec[key] = value;
    }
    return result;
  }

  async getEntryLinksBatch(entryIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (entryIds.length === 0) return result;
    const rows = this.queryChunked(
      entryIds,
      (ph) => `SELECT journal_entry_id, link_name FROM entry_link WHERE journal_entry_id IN (${ph}) ORDER BY link_name`,
      [],
      (row) => ({ id: row.journal_entry_id as string, link_name: row.link_name as string }),
    );
    for (const { id, link_name } of rows) {
      let list = result.get(id);
      if (!list) {
        list = [];
        result.set(id, list);
      }
      list.push(link_name);
    }
    return result;
  }

  async getAllTagValues(): Promise<string[]> {
    const rows = this.query(
      "SELECT DISTINCT value FROM journal_entry_metadata WHERE key = 'tags'",
      [],
      (row) => row.value as string,
    );
    const tagSet = new Set<string>();
    for (const raw of rows) {
      for (const t of parseTags(raw)) {
        tagSet.add(t);
      }
    }
    return [...tagSet].sort();
  }

  async getAllMetadataKeys(): Promise<string[]> {
    return this.query(
      "SELECT DISTINCT key FROM journal_entry_metadata WHERE key != 'tags' ORDER BY key",
      [],
      (row) => row.key as string,
    );
  }

  // ---- Backend: Entry Links ----

  async setEntryLinks(entryId: string, links: string[]): Promise<void> {
    this.run("DELETE FROM entry_link WHERE journal_entry_id = ?", [entryId]);
    for (const link of links) {
      const normalized = link.trim().toLowerCase();
      if (normalized) {
        this.run(
          "INSERT OR IGNORE INTO entry_link (journal_entry_id, link_name) VALUES (?, ?)",
          [entryId, normalized],
        );
      }
    }
    this.scheduleSave();
  }

  async getEntryLinks(entryId: string): Promise<string[]> {
    return this.query(
      "SELECT link_name FROM entry_link WHERE journal_entry_id = ? ORDER BY link_name",
      [entryId],
      (row) => row.link_name as string,
    );
  }

  async getEntriesByLink(linkName: string): Promise<string[]> {
    return this.query(
      `SELECT el.journal_entry_id FROM entry_link el
       JOIN journal_entry je ON je.id = el.journal_entry_id
       WHERE el.link_name = ? AND je.status != 'voided'
       ORDER BY je.date DESC`,
      [linkName],
      (row) => row.journal_entry_id as string,
    );
  }

  async getAllLinkNames(): Promise<string[]> {
    return this.query(
      "SELECT DISTINCT link_name FROM entry_link ORDER BY link_name",
      [],
      (row) => row.link_name as string,
    );
  }

  async getAllLinksWithCounts(): Promise<Array<{ link_name: string; entry_count: number }>> {
    return this.query(
      `SELECT el.link_name, COUNT(DISTINCT el.journal_entry_id) as entry_count
       FROM entry_link el
       JOIN journal_entry je ON je.id = el.journal_entry_id
       WHERE je.status != 'voided'
       GROUP BY el.link_name
       ORDER BY el.link_name`,
      [],
      (row) => ({ link_name: row.link_name as string, entry_count: row.entry_count as number }),
    );
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

  async syncTheGraph(
    apiKey: string,
    address: string,
    label: string,
    chainId: number,
  ): Promise<EtherscanSyncResult> {
    const { syncTheGraphWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    this.beginTransaction();
    try {
      const result = await syncTheGraphWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
      this.commitTransaction();
      return result;
    } catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  }

  // ---- Bitcoin ----

  async listBitcoinAccounts(): Promise<import("./bitcoin/types.js").BitcoinAccount[]> {
    return this.query(
      "SELECT id, address_or_xpub, account_type, derivation_bip, network, label, last_receive_index, last_change_index, last_sync, created_at FROM bitcoin_account ORDER BY created_at",
      [],
      (row) => ({
        id: row.id as string,
        address_or_xpub: row.address_or_xpub as string,
        account_type: row.account_type as "address" | "xpub" | "ypub" | "zpub",
        derivation_bip: (row.derivation_bip as number) ?? undefined,
        network: row.network as "mainnet" | "testnet",
        label: row.label as string,
        last_receive_index: (row.last_receive_index as number) ?? 0,
        last_change_index: (row.last_change_index as number) ?? 0,
        last_sync: (row.last_sync as string) ?? null,
        created_at: row.created_at as string,
      }),
    );
  }

  async addBitcoinAccount(account: Omit<import("./bitcoin/types.js").BitcoinAccount, "last_sync">): Promise<void> {
    this.run(
      `INSERT INTO bitcoin_account (id, address_or_xpub, account_type, derivation_bip, network, label, last_receive_index, last_change_index, last_sync, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [account.id, account.address_or_xpub, account.account_type, account.derivation_bip ?? null,
       account.network, account.label, account.last_receive_index, account.last_change_index, account.created_at],
    );
    this.scheduleSave();
  }

  async removeBitcoinAccount(id: string): Promise<void> {
    this.run("DELETE FROM btc_derived_address WHERE bitcoin_account_id = ?", [id]);
    this.run("DELETE FROM bitcoin_account WHERE id = ?", [id]);
    this.scheduleSave();
  }

  async getBtcTrackedAddresses(accountId: string): Promise<string[]> {
    // Check if it's a single-address account
    const account = this.queryOne(
      "SELECT account_type, address_or_xpub FROM bitcoin_account WHERE id = ?",
      [accountId],
      (row) => ({ account_type: row.account_type as string, address_or_xpub: row.address_or_xpub as string }),
    );
    if (account && account.account_type === "address") {
      return [account.address_or_xpub];
    }
    return this.query(
      "SELECT address FROM btc_derived_address WHERE bitcoin_account_id = ? ORDER BY change_chain, address_index",
      [accountId],
      (row) => row.address as string,
    );
  }

  async storeBtcDerivedAddresses(accountId: string, addresses: Array<{address: string; change: number; index: number}>): Promise<void> {
    for (const addr of addresses) {
      this.run(
        `INSERT OR IGNORE INTO btc_derived_address (address, bitcoin_account_id, change_chain, address_index) VALUES (?, ?, ?, ?)`,
        [addr.address, accountId, addr.change, addr.index],
      );
    }
    this.scheduleSave();
  }

  async updateBtcDerivationIndex(accountId: string, receiveIndex: number, changeIndex: number): Promise<void> {
    this.run(
      "UPDATE bitcoin_account SET last_receive_index = ?, last_change_index = ?, last_sync = ? WHERE id = ?",
      [receiveIndex, changeIndex, new Date().toISOString(), accountId],
    );
    this.scheduleSave();
  }

  async syncBitcoin(
    account: import("./bitcoin/types.js").BitcoinAccount,
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<import("./bitcoin/types.js").BitcoinSyncResult> {
    const { syncBitcoinAccount } = await import("./bitcoin/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    const allAccounts = await this.listBitcoinAccounts();
    this.beginTransaction();
    try {
      const result = await syncBitcoinAccount(this, account, allAccounts, loadSettings(), onProgress, signal);
      this.commitTransaction();
      return result;
    } catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  }

  // ---- Solana ----

  async listSolanaAccounts(): Promise<import("./solana/types.js").SolanaAccount[]> {
    return this.query(
      "SELECT id, address, network, label, last_signature, last_sync, created_at FROM solana_account ORDER BY created_at",
      [],
      (row) => ({
        id: row.id as string,
        address: row.address as string,
        network: row.network as "mainnet-beta" | "devnet" | "testnet",
        label: row.label as string,
        last_signature: (row.last_signature as string) ?? null,
        last_sync: (row.last_sync as string) ?? null,
        created_at: row.created_at as string,
      }),
    );
  }

  async addSolanaAccount(account: Omit<import("./solana/types.js").SolanaAccount, "last_sync">): Promise<void> {
    this.run(
      `INSERT INTO solana_account (id, address, network, label, last_signature, last_sync, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [account.id, account.address, account.network, account.label, account.last_signature ?? null, account.created_at],
    );
    this.scheduleSave();
  }

  async removeSolanaAccount(id: string): Promise<void> {
    this.run("DELETE FROM solana_account WHERE id = ?", [id]);
    this.scheduleSave();
  }

  async updateSolanaLastSignature(id: string, signature: string): Promise<void> {
    this.run(
      "UPDATE solana_account SET last_signature = ?, last_sync = ? WHERE id = ?",
      [signature, new Date().toISOString(), id],
    );
    this.scheduleSave();
  }

  async syncSolana(
    account: import("./solana/types.js").SolanaAccount,
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<import("./solana/types.js").SolanaSyncResult> {
    const { syncSolanaAccount } = await import("./solana/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    this.beginTransaction();
    try {
      const result = await syncSolanaAccount(this, account, loadSettings(), onProgress, signal);
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
      "SELECT id, exchange, label, api_key, api_secret, passphrase, opened_at, closed_at, last_sync, created_at FROM exchange_account ORDER BY created_at",
      [],
      (row) => ({
        id: row.id as string,
        exchange: row.exchange as import("./cex/types.js").ExchangeId,
        label: row.label as string,
        api_key: row.api_key as string,
        api_secret: row.api_secret as string,
        passphrase: (row.passphrase as string) ?? null,
        opened_at: (row.opened_at as string) ?? null,
        closed_at: (row.closed_at as string) ?? null,
        last_sync: (row.last_sync as string) ?? null,
        created_at: row.created_at as string,
      }),
    );
  }

  async addExchangeAccount(account: import("./cex/types.js").ExchangeAccount): Promise<void> {
    this.run(
      `INSERT INTO exchange_account (id, exchange, label, api_key, api_secret, linked_etherscan_account_id, passphrase, opened_at, closed_at, last_sync, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [account.id, account.exchange, account.label, account.api_key, account.api_secret,
       null, account.passphrase ?? null, account.opened_at ?? null, account.closed_at ?? null, account.last_sync, account.created_at],
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
    if (updates.opened_at !== undefined) { sets.push("opened_at = ?"); params.push(updates.opened_at); }
    if (updates.closed_at !== undefined) { sets.push("closed_at = ?"); params.push(updates.closed_at); }
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
      "SELECT currency, asset_type, param, rate_source, rate_source_id, set_by, updated_at FROM currency_rate_source ORDER BY currency",
      [],
      (row) => ({
        currency: row.currency as string,
        asset_type: (row.asset_type as string) ?? "",
        param: (row.param as string) ?? "",
        rate_source: (row.rate_source as string | null) ?? null,
        rate_source_id: (row.rate_source_id as string) ?? "",
        set_by: row.set_by as string,
        updated_at: row.updated_at as string,
      }),
    );
  }

  async setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string, rateSourceId?: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const sourceId = rateSourceId ?? "";

    // Check existing row for priority (composite PK: currency, asset_type, param)
    const existing = this.queryOne(
      "SELECT set_by FROM currency_rate_source WHERE currency = ? AND asset_type = '' AND param = ''",
      [currency],
      (row) => row.set_by as string,
    );

    if (rateSource === null) {
      // null means "clear" — delete the row
      this.run(
        "DELETE FROM currency_rate_source WHERE currency = ? AND asset_type = '' AND param = ''",
        [currency],
      );
    } else if (existing !== null) {
      const existingPriority = setByPriority(existing);
      const newPriority = setByPriority(setBy);
      if (newPriority < existingPriority) {
        return false; // Skip: existing has higher priority
      }
      this.run(
        "UPDATE currency_rate_source SET rate_source = ?, rate_source_id = ?, set_by = ?, updated_at = ? WHERE currency = ? AND asset_type = '' AND param = ''",
        [rateSource, sourceId, setBy, today, currency],
      );
    } else {
      this.run(
        "INSERT INTO currency_rate_source (currency, asset_type, param, rate_source, rate_source_id, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [currency, "", "", rateSource, sourceId, setBy, today],
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
      "INSERT INTO balance_assertion (id, account_id, date, currency, currency_asset_type, currency_param, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [assertion.id, assertion.account_id, assertion.date, assertion.currency, assertion.currency_asset_type ?? "", assertion.currency_param ?? "", assertion.expected_balance, isPassing ? 1 : 0, actualAmount, assertion.is_strict ? 1 : 0, assertion.include_subaccounts ? 1 : 0],
    );
    this.scheduleSave();
  }

  async listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]> {
    let sql = "SELECT id, account_id, date, currency, currency_asset_type, currency_param, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts FROM balance_assertion";
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
      currency_asset_type: (row.currency_asset_type as string) ?? "",
      currency_param: (row.currency_param as string) ?? "",
      expected_balance: row.expected_balance as string,
      is_passing: (row.is_passing as number) !== 0,
      actual_balance: row.actual_balance as string | null,
      is_strict: (row.is_strict as number) !== 0,
      include_subaccounts: (row.include_subaccounts as number) !== 0,
    }));
  }

  async checkBalanceAssertions(): Promise<BalanceAssertionResult[]> {
    const assertions = await this.listBalanceAssertions();
    if (assertions.length === 0) return [];

    // Batch: compute balances once per distinct date
    const distinctDates = [...new Set(assertions.map((a) => a.date))];
    const balancesByDate = new Map<string, Map<string, CurrencyBalance[]>>();
    for (const date of distinctDates) {
      balancesByDate.set(date, await this.sumAllLineItemsByAccount(date));
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

  private deleteFromTables(tables: string[]): void {
    for (const table of tables) {
      try { this.db.exec(`DELETE FROM "${table}"`); } catch { /* table may not exist */ }
    }
  }

  async clearLedgerData(): Promise<void> {
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.deleteFromTables([
      "reconciliation_line_item", "reconciliation",
      "lot_disposal", "lot", "line_item", "entry_link",
      "journal_entry_metadata", "balance_assertion", "audit_log",
      "journal_entry", "raw_transaction", "currency_rate_source",
      "budget", "recurring_template", "french_tax_report", "currency_token_address",
      "account_metadata", "account_closure", "account", "currency",
    ]);
    try { this.db.exec("UPDATE exchange_account SET last_sync = NULL"); } catch { /* may not exist */ }
    this.db.exec("PRAGMA foreign_keys=ON");
    this.scheduleSave();
  }

  // French tax reports
  async saveFrenchTaxReport(taxYear: number, report: FrenchTaxReport, checklist?: Record<string, boolean>): Promise<void> {
    this.run(
      "INSERT OR REPLACE INTO french_tax_report (tax_year, generated_at, final_acquisition_cost, report_json) VALUES (?, ?, ?, ?)",
      [taxYear, new Date().toISOString(), report.finalAcquisitionCost, JSON.stringify({ report, checklist: checklist ?? {} })]
    );
    this.scheduleSave();
  }

  async getFrenchTaxReport(taxYear: number): Promise<PersistedFrenchTaxReport | null> {
    return this.queryOne(
      "SELECT generated_at, final_acquisition_cost, report_json FROM french_tax_report WHERE tax_year = ?",
      [taxYear],
      (row) => {
        const parsed = JSON.parse(row.report_json as string);
        // Backward compat: old format stored bare FrenchTaxReport (has taxYear field)
        if (parsed.taxYear !== undefined) {
          return {
            generatedAt: row.generated_at as string,
            finalAcquisitionCost: row.final_acquisition_cost as string,
            report: parsed,
            checklist: {},
          };
        }
        return {
          generatedAt: row.generated_at as string,
          finalAcquisitionCost: row.final_acquisition_cost as string,
          report: parsed.report,
          checklist: parsed.checklist ?? {},
        };
      },
    );
  }

  async listFrenchTaxReportYears(): Promise<number[]> {
    const rows = this.db.exec("SELECT tax_year FROM french_tax_report ORDER BY tax_year");
    if (rows.length === 0) return [];
    return rows[0].values.map(r => r[0] as number);
  }

  async deleteFrenchTaxReport(taxYear: number): Promise<void> {
    this.run("DELETE FROM french_tax_report WHERE tax_year = ?", [taxYear]);
    this.scheduleSave();
  }

  async repairDatabase(): Promise<string[]> {
    const repairs: string[] = [];
    try {
      this.db.exec("SELECT generated_at, final_acquisition_cost, report_json FROM french_tax_report LIMIT 0");
    } catch {
      this.db.exec("DROP TABLE IF EXISTS french_tax_report");
      this.db.exec(`CREATE TABLE IF NOT EXISTS french_tax_report (
        tax_year INTEGER PRIMARY KEY NOT NULL,
        generated_at TEXT NOT NULL,
        final_acquisition_cost TEXT NOT NULL,
        report_json TEXT NOT NULL
      )`);
      repairs.push("Recreated french_tax_report table (missing columns)");
    }
    if (repairs.length > 0) this.scheduleSave();
    return repairs;
  }

  async clearAllData(): Promise<void> {
    this.db.close();
    this.db = new this.sql.Database();
    this.db.exec("PRAGMA foreign_keys=ON");
    SqlJsBackend.initFreshSchema(this.db);
    this.scheduleSave();
  }
}
