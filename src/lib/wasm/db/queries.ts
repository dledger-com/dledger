/**
 * TypeScript port of src-tauri/src/db.rs SQL operations for wa-sqlite.
 * All decimal amounts are stored/returned as strings.
 * UUID v7 primary keys stored as strings.
 */

import { v7 as uuidv7 } from "uuid";
import type { WaSqliteDb, SqlValue } from "./wa-sqlite.js";
import type {
  Account,
  AccountType,
  Currency,
} from "$lib/types/account.js";
import type {
  JournalEntry,
  JournalEntryStatus,
  LineItem,
  TransactionFilter,
} from "$lib/types/journal.js";
import type {
  CurrencyBalance,
  TrialBalance,
  TrialBalanceLine,
  IncomeStatement,
  ReportSection,
  BalanceSheet,
  GainLossReport,
  GainLossLine,
} from "$lib/types/report.js";
import type { ExchangeRate } from "$lib/types/index.js";

// ——— Decimal arithmetic helpers (string-based) ———

function decimalAdd(a: string, b: string): string {
  return String(Number(a) + Number(b));
}

function decimalSub(a: string, b: string): string {
  return String(Number(a) - Number(b));
}

function decimalMul(a: string, b: string): string {
  return String(Number(a) * Number(b));
}

function decimalNeg(a: string): string {
  return String(-Number(a));
}

function decimalAbs(a: string): string {
  return String(Math.abs(Number(a)));
}

function decimalGt(a: string, b: string): boolean {
  return Number(a) > Number(b);
}

function decimalLt(a: string, b: string): boolean {
  return Number(a) < Number(b);
}

function decimalIsZero(a: string): boolean {
  return Number(a) === 0;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ——— Currency ———

export async function listCurrencies(db: WaSqliteDb): Promise<Currency[]> {
  const rows = await db.query(
    "SELECT code, name, decimal_places, is_base FROM currency ORDER BY code",
  );
  return rows.map((r) => ({
    code: r.code as string,
    name: r.name as string,
    decimal_places: r.decimal_places as number,
    is_base: (r.is_base as number) !== 0,
  }));
}

export async function createCurrency(
  db: WaSqliteDb,
  currency: Currency,
): Promise<void> {
  await db.exec(
    "INSERT INTO currency (code, name, decimal_places, is_base) VALUES (?1, ?2, ?3, ?4)",
    [currency.code, currency.name, currency.decimal_places, currency.is_base ? 1 : 0],
  );
  await insertAuditLog(db, "create", "currency", currency.code, currency.code);
}

// ——— Accounts ———

export async function listAccounts(db: WaSqliteDb): Promise<Account[]> {
  const rows = await db.query(
    `SELECT id, parent_id, account_type, name, full_name, allowed_currencies,
            is_postable, is_archived, created_at
     FROM account ORDER BY full_name`,
  );
  return rows.map(rowToAccount);
}

export async function getAccount(
  db: WaSqliteDb,
  id: string,
): Promise<Account | null> {
  const row = await db.queryOne(
    `SELECT id, parent_id, account_type, name, full_name, allowed_currencies,
            is_postable, is_archived, created_at
     FROM account WHERE id = ?1`,
    [id],
  );
  return row ? rowToAccount(row) : null;
}

export async function createAccount(
  db: WaSqliteDb,
  account: Account,
): Promise<void> {
  const allowedJson = JSON.stringify(account.allowed_currencies);
  await db.exec(
    `INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      account.id,
      account.parent_id,
      account.account_type,
      account.name,
      account.full_name,
      allowedJson,
      account.is_postable ? 1 : 0,
      account.is_archived ? 1 : 0,
      account.created_at,
    ],
  );
  await insertClosureEntries(db, account.id, account.parent_id);
  await insertAuditLog(db, "create", "account", account.id, account.full_name);
}

export async function archiveAccount(
  db: WaSqliteDb,
  id: string,
): Promise<void> {
  await db.exec("UPDATE account SET is_archived = 1 WHERE id = ?1", [id]);
  await insertAuditLog(db, "archive", "account", id, id);
}

async function insertClosureEntries(
  db: WaSqliteDb,
  accountId: string,
  parentId: string | null,
): Promise<void> {
  // Self-referencing entry
  await db.exec(
    "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
    [accountId, accountId],
  );
  if (parentId) {
    // Copy all ancestor relationships from parent, incrementing depth
    await db.exec(
      `INSERT INTO account_closure (ancestor_id, descendant_id, depth)
       SELECT ancestor_id, ?1, depth + 1
       FROM account_closure
       WHERE descendant_id = ?2`,
      [accountId, parentId],
    );
  }
}

async function getAccountSubtreeIds(
  db: WaSqliteDb,
  id: string,
): Promise<string[]> {
  const rows = await db.query(
    "SELECT descendant_id FROM account_closure WHERE ancestor_id = ?1 ORDER BY depth",
    [id],
  );
  return rows.map((r) => r.descendant_id as string);
}

// ——— Journal entries + line items ———

export async function postJournalEntry(
  db: WaSqliteDb,
  entry: JournalEntry,
  items: LineItem[],
): Promise<void> {
  await db.exec(
    `INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
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
    await db.exec(
      `INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
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
  await insertAuditLog(db, "post", "journal_entry", entry.id, entry.description);
}

export async function voidJournalEntry(
  db: WaSqliteDb,
  id: string,
): Promise<JournalEntry> {
  const result = await getJournalEntry(db, id);
  if (!result) throw new Error(`Journal entry ${id} not found`);
  const [original, items] = result;
  if (original.status === "voided") throw new Error(`Journal entry ${id} is already voided`);

  // Create reversing entry
  const reversalId = uuidv7();
  const today = todayStr();
  const reversal: JournalEntry = {
    id: reversalId,
    date: today,
    description: `Reversal of: ${original.description}`,
    status: "confirmed",
    source: "system:void",
    voided_by: null,
    created_at: today,
  };

  const reversalItems: LineItem[] = items.map((item) => ({
    id: uuidv7(),
    journal_entry_id: reversalId,
    account_id: item.account_id,
    currency: item.currency,
    amount: decimalNeg(item.amount),
    lot_id: null,
  }));

  await postJournalEntry(db, reversal, reversalItems);
  await db.exec(
    "UPDATE journal_entry SET status = ?1, voided_by = ?2 WHERE id = ?3",
    ["voided", reversalId, id],
  );

  return reversal;
}

export async function getJournalEntry(
  db: WaSqliteDb,
  id: string,
): Promise<[JournalEntry, LineItem[]] | null> {
  const entryRow = await db.queryOne(
    `SELECT id, date, description, status, source, voided_by, created_at
     FROM journal_entry WHERE id = ?1`,
    [id],
  );
  if (!entryRow) return null;
  const entry = rowToJournalEntry(entryRow);
  const items = await fetchLineItemsForEntry(db, entry.id);
  return [entry, items];
}

export async function queryJournalEntries(
  db: WaSqliteDb,
  filter: TransactionFilter,
): Promise<[JournalEntry, LineItem[]][]> {
  let sql =
    "SELECT DISTINCT je.id, je.date, je.description, je.status, je.source, je.voided_by, je.created_at FROM journal_entry je";
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (filter.account_id) {
    sql += " JOIN line_item li ON li.journal_entry_id = je.id";
  }

  if (filter.account_id) {
    params.push(filter.account_id);
    conditions.push(`li.account_id = ?${params.length}`);
  }
  if (filter.from_date) {
    params.push(filter.from_date);
    conditions.push(`je.date >= ?${params.length}`);
  }
  if (filter.to_date) {
    params.push(filter.to_date);
    conditions.push(`je.date <= ?${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`je.status = ?${params.length}`);
  }
  if (filter.source) {
    params.push(filter.source);
    conditions.push(`je.source = ?${params.length}`);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY je.date DESC, je.created_at DESC";

  if (filter.limit != null) {
    params.push(filter.limit);
    sql += ` LIMIT ?${params.length}`;
  }
  if (filter.offset != null) {
    params.push(filter.offset);
    sql += ` OFFSET ?${params.length}`;
  }

  const entryRows = await db.query(sql, params);
  const entries = entryRows.map(rowToJournalEntry);

  const results: [JournalEntry, LineItem[]][] = [];
  for (const entry of entries) {
    const items = await fetchLineItemsForEntry(db, entry.id);
    results.push([entry, items]);
  }
  return results;
}

async function fetchLineItemsForEntry(
  db: WaSqliteDb,
  entryId: string,
): Promise<LineItem[]> {
  const rows = await db.query(
    `SELECT id, journal_entry_id, account_id, currency, amount, lot_id
     FROM line_item WHERE journal_entry_id = ?1`,
    [entryId],
  );
  return rows.map(rowToLineItem);
}

// ——— Balances ———

export async function getAccountBalance(
  db: WaSqliteDb,
  accountId: string,
  asOf?: string,
): Promise<CurrencyBalance[]> {
  return sumLineItems(db, [accountId], asOf);
}

export async function getAccountBalanceWithChildren(
  db: WaSqliteDb,
  accountId: string,
  asOf?: string,
): Promise<CurrencyBalance[]> {
  const subtreeIds = await getAccountSubtreeIds(db, accountId);
  if (subtreeIds.length === 0) return [];
  return sumLineItems(db, subtreeIds, asOf);
}

async function sumLineItems(
  db: WaSqliteDb,
  accountIds: string[],
  beforeDate?: string,
): Promise<CurrencyBalance[]> {
  if (accountIds.length === 0) return [];

  const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(", ");
  let sql = `SELECT li.currency, li.amount
     FROM line_item li
     JOIN journal_entry je ON je.id = li.journal_entry_id
     WHERE li.account_id IN (${placeholders})`;

  const params: SqlValue[] = [...accountIds];

  if (beforeDate) {
    params.push(beforeDate);
    sql += ` AND je.date < ?${params.length}`;
  }

  const rows = await db.query(sql, params);

  // Sum amounts per currency (using JS numbers — sufficient for display)
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = row.currency as string;
    const amount = Number(row.amount as string);
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }

  const balances: CurrencyBalance[] = [];
  for (const [currency, amount] of totals) {
    balances.push({ currency, amount: String(amount) });
  }
  balances.sort((a, b) => a.currency.localeCompare(b.currency));
  return balances;
}

// ——— Exchange rates ———

export async function recordExchangeRate(
  db: WaSqliteDb,
  rate: ExchangeRate,
): Promise<void> {
  const id = rate.id || uuidv7();
  await db.exec(
    `INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [id, rate.date, rate.from_currency, rate.to_currency, rate.rate, rate.source],
  );
}

export async function getExchangeRate(
  db: WaSqliteDb,
  from: string,
  to: string,
  date: string,
): Promise<string | null> {
  const row = await db.queryOne(
    `SELECT rate FROM exchange_rate
     WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3
     ORDER BY date DESC LIMIT 1`,
    [from, to, date],
  );
  return row ? (row.rate as string) : null;
}

export async function listExchangeRates(
  db: WaSqliteDb,
  from?: string,
  to?: string,
): Promise<ExchangeRate[]> {
  let sql =
    "SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate";
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (from) {
    params.push(from);
    conditions.push(`from_currency = ?${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`to_currency = ?${params.length}`);
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY date DESC";

  const rows = await db.query(sql, params);
  return rows.map((r) => ({
    id: r.id as string,
    date: r.date as string,
    from_currency: r.from_currency as string,
    to_currency: r.to_currency as string,
    rate: r.rate as string,
    source: r.source as string,
  }));
}

// ——— Reports ———

export async function trialBalance(
  db: WaSqliteDb,
  asOf: string,
): Promise<TrialBalance> {
  const accounts = await listAccounts(db);
  const lines: TrialBalanceLine[] = [];
  const debitTotals = new Map<string, number>();
  const creditTotals = new Map<string, number>();

  for (const account of accounts) {
    if (!account.is_postable) continue;
    const balances = await sumLineItems(db, [account.id], asOf);
    if (balances.length === 0) continue;

    for (const bal of balances) {
      const amt = Number(bal.amount);
      if (amt > 0) {
        debitTotals.set(bal.currency, (debitTotals.get(bal.currency) ?? 0) + amt);
      } else if (amt < 0) {
        creditTotals.set(
          bal.currency,
          (creditTotals.get(bal.currency) ?? 0) + Math.abs(amt),
        );
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

export async function incomeStatement(
  db: WaSqliteDb,
  fromDate: string,
  toDate: string,
): Promise<IncomeStatement> {
  const accounts = await listAccounts(db);
  const revenueLines: TrialBalanceLine[] = [];
  const expenseLines: TrialBalanceLine[] = [];
  const revenueTotals = new Map<string, number>();
  const expenseTotals = new Map<string, number>();

  for (const account of accounts) {
    if (!account.is_postable) continue;
    if (account.account_type !== "revenue" && account.account_type !== "expense")
      continue;

    const balEnd = await sumLineItems(db, [account.id], toDate);
    const balStart = await sumLineItems(db, [account.id], fromDate);
    const periodBal = subtractBalances(balEnd, balStart);
    if (periodBal.length === 0) continue;

    const line: TrialBalanceLine = {
      account_id: account.id,
      account_name: account.full_name,
      account_type: account.account_type,
      balances: periodBal,
    };

    const totalsMap =
      account.account_type === "revenue" ? revenueTotals : expenseTotals;
    for (const bal of periodBal) {
      totalsMap.set(bal.currency, (totalsMap.get(bal.currency) ?? 0) + Number(bal.amount));
    }

    if (account.account_type === "revenue") {
      revenueLines.push(line);
    } else {
      expenseLines.push(line);
    }
  }

  // Net income = -(revenue + expenses)
  const netIncomeMap = new Map<string, number>();
  for (const [currency, amount] of revenueTotals) {
    netIncomeMap.set(currency, (netIncomeMap.get(currency) ?? 0) - amount);
  }
  for (const [currency, amount] of expenseTotals) {
    netIncomeMap.set(currency, (netIncomeMap.get(currency) ?? 0) - amount);
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

export async function balanceSheet(
  db: WaSqliteDb,
  asOf: string,
): Promise<BalanceSheet> {
  const accounts = await listAccounts(db);
  const assetLines: TrialBalanceLine[] = [];
  const liabilityLines: TrialBalanceLine[] = [];
  const equityLines: TrialBalanceLine[] = [];
  const assetTotals = new Map<string, number>();
  const liabilityTotals = new Map<string, number>();
  const equityTotals = new Map<string, number>();

  for (const account of accounts) {
    if (!account.is_postable) continue;
    let totalsMap: Map<string, number>;
    if (account.account_type === "asset") totalsMap = assetTotals;
    else if (account.account_type === "liability") totalsMap = liabilityTotals;
    else if (account.account_type === "equity") totalsMap = equityTotals;
    else continue;

    const balances = await sumLineItems(db, [account.id], asOf);
    if (balances.length === 0) continue;

    for (const bal of balances) {
      totalsMap.set(bal.currency, (totalsMap.get(bal.currency) ?? 0) + Number(bal.amount));
    }

    const line: TrialBalanceLine = {
      account_id: account.id,
      account_name: account.full_name,
      account_type: account.account_type,
      balances,
    };

    if (account.account_type === "asset") assetLines.push(line);
    else if (account.account_type === "liability") liabilityLines.push(line);
    else equityLines.push(line);
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

export async function gainLossReport(
  db: WaSqliteDb,
  fromDate: string,
  toDate: string,
): Promise<GainLossReport> {
  const disposals = await db.query(
    `SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit,
            proceeds_currency, realized_gain_loss, disposal_date
     FROM lot_disposal
     WHERE disposal_date >= ?1 AND disposal_date <= ?2
     ORDER BY disposal_date ASC`,
    [fromDate, toDate],
  );

  const lines: GainLossLine[] = [];
  let totalGainLoss = 0;

  for (const d of disposals) {
    const lotRow = await db.queryOne(
      `SELECT currency, acquired_date, cost_basis_per_unit FROM lot WHERE id = ?1`,
      [d.lot_id as string],
    );
    if (!lotRow) continue;

    const quantity = Number(d.quantity as string);
    const costBasis = quantity * Number(lotRow.cost_basis_per_unit as string);
    const proceeds = quantity * Number(d.proceeds_per_unit as string);
    const gainLoss = Number(d.realized_gain_loss as string);

    lines.push({
      lot_id: d.lot_id as string,
      currency: lotRow.currency as string,
      acquired_date: lotRow.acquired_date as string,
      disposed_date: d.disposal_date as string,
      quantity: String(quantity),
      cost_basis: String(costBasis),
      proceeds: String(proceeds),
      gain_loss: String(gainLoss),
    });

    totalGainLoss += gainLoss;
  }

  return {
    from_date: fromDate,
    to_date: toDate,
    lines,
    total_gain_loss: String(totalGainLoss),
  };
}

// ——— CSV Import (delegates to plugin in Phase 3, stub for now) ———

export async function importCsv(
  _db: WaSqliteDb,
  _params: {
    csvData: string;
    account: string;
    contraAccount: string;
    currency: string;
    dateColumn: number;
    descriptionColumn: number;
    amountColumn: number;
    dateFormat: string;
    skipHeader: boolean;
    delimiter: string;
  },
): Promise<string> {
  throw new Error("CSV import via WasmBackend requires the csv-import plugin (Phase 3)");
}

// ——— Audit log ———

async function insertAuditLog(
  db: WaSqliteDb,
  action: string,
  entityType: string,
  entityId: string,
  details: string,
): Promise<void> {
  await db.exec(
    `INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [uuidv7(), todayStr(), action, entityType, entityId, details],
  );
}

// ——— Row mapping helpers ———

function rowToAccount(row: Record<string, unknown>): Account {
  let allowed: string[] = [];
  try {
    allowed = JSON.parse((row.allowed_currencies as string) || "[]");
  } catch {
    /* empty */
  }
  return {
    id: row.id as string,
    parent_id: (row.parent_id as string) || null,
    account_type: row.account_type as AccountType,
    name: row.name as string,
    full_name: row.full_name as string,
    allowed_currencies: allowed,
    is_postable: (row.is_postable as number) !== 0,
    is_archived: (row.is_archived as number) !== 0,
    created_at: row.created_at as string,
  };
}

function rowToJournalEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as string,
    date: row.date as string,
    description: row.description as string,
    status: row.status as JournalEntryStatus,
    source: row.source as string,
    voided_by: (row.voided_by as string) || null,
    created_at: row.created_at as string,
  };
}

function rowToLineItem(row: Record<string, unknown>): LineItem {
  return {
    id: row.id as string,
    journal_entry_id: row.journal_entry_id as string,
    account_id: row.account_id as string,
    currency: row.currency as string,
    amount: row.amount as string,
    lot_id: (row.lot_id as string) || null,
  };
}

// ——— Balance helpers ———

function subtractBalances(
  end: CurrencyBalance[],
  start: CurrencyBalance[],
): CurrencyBalance[] {
  const startMap = new Map(start.map((b) => [b.currency, Number(b.amount)]));
  const result = new Map<string, number>();

  for (const bal of end) {
    const startAmt = startMap.get(bal.currency) ?? 0;
    const diff = Number(bal.amount) - startAmt;
    if (diff !== 0) result.set(bal.currency, diff);
  }

  for (const bal of start) {
    if (!result.has(bal.currency) && !end.some((e) => e.currency === bal.currency)) {
      const diff = -Number(bal.amount);
      if (diff !== 0) result.set(bal.currency, diff);
    }
  }

  return mapToBalances(result);
}

function mapToBalances(map: Map<string, number>): CurrencyBalance[] {
  return Array.from(map.entries()).map(([currency, amount]) => ({
    currency,
    amount: String(amount),
  }));
}
