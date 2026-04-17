import { afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { Account, Currency, JournalEntry, LineItem } from "$lib/types/index.js";

// ── Auto-close tracking ───────────────────────────────────────────
// sql.js WASM holds internal handles that keep the Node.js event loop alive.
// Track all backends created during tests and close them after each test file.
const _openBackends: SqlJsBackend[] = [];

afterAll(() => {
  for (const b of _openBackends) {
    try { b.close(); } catch { /* already closed */ }
  }
  _openBackends.length = 0;
});

export async function createTestBackend(): Promise<SqlJsBackend> {
  const backend = await SqlJsBackend.createInMemory();
  _openBackends.push(backend);
  return backend;
}

export interface SeededLedger {
  backend: SqlJsBackend;
  currencies: { USD: Currency; EUR: Currency };
  accounts: {
    bank: Account;
    food: Account;
    salary: Account;
    opening: Account;
  };
}

export async function seedBasicLedger(): Promise<SeededLedger> {
  const backend = await createTestBackend();

  const USD: Currency = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 };
  const EUR: Currency = { code: "EUR", asset_type: "", name: "Euro", decimal_places: 2 };
  await backend.createCurrency(USD);
  await backend.createCurrency(EUR);

  // Create parent accounts (non-postable hierarchy)
  const assetsId = uuidv7();
  const assets: Account = {
    id: assetsId, parent_id: null, account_type: "asset",
    name: "Assets", full_name: "Assets",
    allowed_currencies: [], is_postable: false, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(assets);

  const expensesId = uuidv7();
  const expenses: Account = {
    id: expensesId, parent_id: null, account_type: "expense",
    name: "Expenses", full_name: "Expenses",
    allowed_currencies: [], is_postable: false, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(expenses);

  const incomeId = uuidv7();
  const income: Account = {
    id: incomeId, parent_id: null, account_type: "revenue",
    name: "Income", full_name: "Income",
    allowed_currencies: [], is_postable: false, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(income);

  const equityId = uuidv7();
  const equity: Account = {
    id: equityId, parent_id: null, account_type: "equity",
    name: "Equity", full_name: "Equity",
    allowed_currencies: [], is_postable: false, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(equity);

  // Create postable leaf accounts
  const bank: Account = {
    id: uuidv7(), parent_id: assetsId, account_type: "asset",
    name: "Bank", full_name: "Assets:Bank",
    allowed_currencies: [], is_postable: true, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(bank);

  const food: Account = {
    id: uuidv7(), parent_id: expensesId, account_type: "expense",
    name: "Food", full_name: "Expenses:Food",
    allowed_currencies: [], is_postable: true, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(food);

  const salary: Account = {
    id: uuidv7(), parent_id: incomeId, account_type: "revenue",
    name: "Salary", full_name: "Income:Salary",
    allowed_currencies: [], is_postable: true, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(salary);

  const opening: Account = {
    id: uuidv7(), parent_id: equityId, account_type: "equity",
    name: "Opening", full_name: "Equity:Opening",
    allowed_currencies: [], is_postable: true, is_archived: false,
    created_at: "2024-01-01",
  };
  await backend.createAccount(opening);

  // Post a few journal entries
  // 1. Opening balance: $1000 in bank
  const entry1Id = uuidv7();
  const entry1: JournalEntry = {
    id: entry1Id, date: "2024-01-01", description: "Opening balance",
    status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-01",
  };
  const items1: LineItem[] = [
    { id: uuidv7(), journal_entry_id: entry1Id, account_id: bank.id, currency: "USD", amount: "1000", lot_id: null },
    { id: uuidv7(), journal_entry_id: entry1Id, account_id: opening.id, currency: "USD", amount: "-1000", lot_id: null },
  ];
  await backend.postJournalEntry(entry1, items1);

  // 2. Salary: $3000
  const entry2Id = uuidv7();
  const entry2: JournalEntry = {
    id: entry2Id, date: "2024-01-15", description: "Salary January",
    status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-15",
  };
  const items2: LineItem[] = [
    { id: uuidv7(), journal_entry_id: entry2Id, account_id: bank.id, currency: "USD", amount: "3000", lot_id: null },
    { id: uuidv7(), journal_entry_id: entry2Id, account_id: salary.id, currency: "USD", amount: "-3000", lot_id: null },
  ];
  await backend.postJournalEntry(entry2, items2);

  // 3. Groceries: $50
  const entry3Id = uuidv7();
  const entry3: JournalEntry = {
    id: entry3Id, date: "2024-01-20", description: "Groceries",
    status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-20",
  };
  const items3: LineItem[] = [
    { id: uuidv7(), journal_entry_id: entry3Id, account_id: food.id, currency: "USD", amount: "50", lot_id: null },
    { id: uuidv7(), journal_entry_id: entry3Id, account_id: bank.id, currency: "USD", amount: "-50", lot_id: null },
  ];
  await backend.postJournalEntry(entry3, items3);

  return {
    backend,
    currencies: { USD, EUR },
    accounts: { bank, food, salary, opening },
  };
}

export function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const id = uuidv7();
  return {
    id,
    date: "2024-01-01",
    description: "Test entry",
    status: "confirmed",
    source: "manual",
    voided_by: null,
    created_at: "2024-01-01",
    ...overrides,
  };
}

export function makeLineItem(
  entryId: string,
  accountId: string,
  currency: string,
  amount: string,
): LineItem {
  return {
    id: uuidv7(),
    journal_entry_id: entryId,
    account_id: accountId,
    currency,
    amount,
    lot_id: null,
  };
}
