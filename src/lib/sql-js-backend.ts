import initSqlJs, { type Database } from "sql.js";
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
  LedgerImportResult,
  EtherscanAccount,
  EtherscanSyncResult,
} from "./types/index.js";
import type { Backend } from "./backend.js";

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
    is_base INTEGER NOT NULL DEFAULT 0
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
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(db: Database) {
    this.db = db;
  }

  static async create(): Promise<SqlJsBackend> {
    const SQL = await initSqlJs({
      locateFile: () => `/sql-wasm.wasm`,
    });
    const saved = await loadFromIndexedDB();
    const db = saved ? new SQL.Database(saved) : new SQL.Database();
    const backend = new SqlJsBackend(db);
    db.run("PRAGMA foreign_keys=ON");
    if (!saved) {
      db.exec(SCHEMA_SQL);
      db.exec("INSERT INTO schema_version (version) VALUES (1)");
    }
    // Handle partially-initialized DB from previous failed session
    const versionRows = db.exec("SELECT version FROM schema_version");
    if (versionRows.length === 0 || versionRows[0].values.length === 0) {
      db.exec("INSERT INTO schema_version (version) VALUES (1)");
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
    while (stmt.step()) {
      results.push(mapRow(stmt.getAsObject()));
    }
    stmt.free();
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
    if (stmt.step()) {
      result = mapRow(stmt.getAsObject());
    }
    stmt.free();
    return result;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = this.db.export();
      saveToIndexedDB(data).catch(console.error);
    }, 500);
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
      "SELECT code, name, decimal_places, is_base FROM currency WHERE code = ?",
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

    const currencies = new Set(items.map((i) => i.currency));
    for (const code of currencies) {
      if (!this.getCurrencyByCode(code)) {
        throw new Error(`currency ${code} does not exist`);
      }
    }

    const accountIds = new Set(items.map((i) => i.account_id));
    for (const accountId of accountIds) {
      const account = this.getAccountById(accountId);
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

  // ---- Backend: Currencies ----

  async listCurrencies(): Promise<Currency[]> {
    return this.query(
      "SELECT code, name, decimal_places, is_base FROM currency ORDER BY code",
      [],
      mapCurrency,
    );
  }

  async createCurrency(currency: Currency): Promise<void> {
    try {
      this.run(
        "INSERT INTO currency (code, name, decimal_places, is_base) VALUES (?, ?, ?, ?)",
        [
          currency.code,
          currency.name,
          currency.decimal_places,
          currency.is_base ? 1 : 0,
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
    return entries.map((entry) => [
      entry,
      this.fetchLineItemsForEntry(entry.id),
    ]);
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

    const lines: TrialBalanceLine[] = [];
    const debitTotals = new Map<string, Decimal>();
    const creditTotals = new Map<string, Decimal>();

    for (const account of accounts) {
      if (!account.is_postable) continue;
      const balances = this.sumLineItems([account.id], asOf);
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

  async incomeStatement(
    fromDate: string,
    toDate: string,
  ): Promise<IncomeStatement> {
    const accounts = this.query(
      "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
      [],
      mapAccount,
    );

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

      const balEnd = this.sumLineItems([account.id], toDate);
      const balStart = this.sumLineItems([account.id], fromDate);
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

      const balances = this.sumLineItems([account.id], asOf);
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

    for (const disposal of disposals) {
      const lot = this.queryOne(
        "SELECT currency, acquired_date, cost_basis_per_unit FROM lot WHERE id = ?",
        [disposal.lot_id],
        (row) => ({
          currency: row.currency as string,
          acquired_date: row.acquired_date as string,
          cost_basis_per_unit: row.cost_basis_per_unit as string,
        }),
      );
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

  // ---- Backend: Exchange rates ----

  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
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

  async getExchangeRate(
    from: string,
    to: string,
    date: string,
  ): Promise<string | null> {
    return this.queryOne(
      "SELECT rate FROM exchange_rate WHERE from_currency = ? AND to_currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
      [from, to, date],
      (row) => row.rate as string,
    );
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
    return importLedger(this, content);
  }

  async exportLedgerFile(): Promise<string> {
    const { exportLedger } = await import("./browser-ledger-file.js");
    return exportLedger(this);
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
    const { syncEtherscan } = await import("./browser-etherscan.js");
    return syncEtherscan(this, apiKey, address, label, chainId);
  }
}
