import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../test/helpers.js";
import type { Account, JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { findReinterpretCandidates, applyReinterpret } from "$lib/reinterpret.js";
import { TAGS_META_KEY } from "$lib/utils/tags.js";

async function setupBackend() {
  const backend = await createTestBackend();

  // Create currencies
  await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 });

  // Create account hierarchy
  const assetsId = uuidv7();
  await backend.createAccount({ id: assetsId, parent_id: null, account_type: "asset", name: "Assets", full_name: "Assets", allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01" });

  const bankId = uuidv7();
  const bank: Account = { id: bankId, parent_id: assetsId, account_type: "asset", name: "Bank", full_name: "Assets:Bank", allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01" };
  await backend.createAccount(bank);

  const expensesId = uuidv7();
  await backend.createAccount({ id: expensesId, parent_id: null, account_type: "expense", name: "Expenses", full_name: "Expenses", allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01" });

  const uncatId = uuidv7();
  const uncat: Account = { id: uncatId, parent_id: expensesId, account_type: "expense", name: "Uncategorized", full_name: "Expenses:Uncategorized", allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01" };
  await backend.createAccount(uncat);

  const groceriesId = uuidv7();
  const groceries: Account = { id: groceriesId, parent_id: expensesId, account_type: "expense", name: "Groceries", full_name: "Expenses:Groceries", allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01" };
  await backend.createAccount(groceries);

  const incomeId = uuidv7();
  await backend.createAccount({ id: incomeId, parent_id: null, account_type: "revenue", name: "Income", full_name: "Income", allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01" });

  const incUncatId = uuidv7();
  const incUncat: Account = { id: incUncatId, parent_id: incomeId, account_type: "revenue", name: "Uncategorized", full_name: "Income:Uncategorized", allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01" };
  await backend.createAccount(incUncat);

  return { backend, bank, uncat, groceries, incUncat };
}

function postEntry(backend: ReturnType<typeof createTestBackend> extends Promise<infer T> ? T : never, bankId: string, counterId: string, description: string, amount: string) {
  const entryId = uuidv7();
  const entry: JournalEntry = {
    id: entryId, date: "2024-03-01", description, status: "confirmed",
    source: "csv-import", voided_by: null, created_at: "2024-03-01",
  };
  const items: LineItem[] = [
    { id: uuidv7(), journal_entry_id: entryId, account_id: bankId, currency: "USD", amount, lot_id: null },
    { id: uuidv7(), journal_entry_id: entryId, account_id: counterId, currency: "USD", amount: String(-parseFloat(amount)), lot_id: null },
  ];
  return backend.postJournalEntry(entry, items).then(() => ({ entryId, entry, items }));
}

describe("findReinterpretCandidates", () => {
  it("finds entries with Expenses:Uncategorized that match a rule", async () => {
    const { backend, bank, uncat } = await setupBackend();
    await postEntry(backend, bank.id, uncat.id, "LIDL groceries", "50");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].oldAccountName).toBe("Expenses:Uncategorized");
    expect(result.candidates[0].newAccountName).toBe("Expenses:Groceries");
  });

  it("skips entries with proper (non-suspense) accounts", async () => {
    const { backend, bank, groceries } = await setupBackend();
    await postEntry(backend, bank.id, groceries.id, "LIDL groceries", "50");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(0);
  });

  it("skips entries with multiple suspense line items", async () => {
    const { backend, uncat, incUncat } = await setupBackend();
    // Entry with two suspense accounts
    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId, date: "2024-03-01", description: "LIDL", status: "confirmed",
      source: "csv-import", voided_by: null, created_at: "2024-03-01",
    };
    const items: LineItem[] = [
      { id: uuidv7(), journal_entry_id: entryId, account_id: uncat.id, currency: "USD", amount: "50", lot_id: null },
      { id: uuidv7(), journal_entry_id: entryId, account_id: incUncat.id, currency: "USD", amount: "-50", lot_id: null },
    ];
    await backend.postJournalEntry(entry, items);

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedMultiSuspense).toBe(1);
  });

  it("skips entries with no matching rule", async () => {
    const { backend, bank, uncat } = await setupBackend();
    await postEntry(backend, bank.id, uncat.id, "Random store", "50");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedNoRule).toBe(1);
  });

  it("skips when rule target equals current account", async () => {
    const { backend, bank, uncat } = await setupBackend();
    await postEntry(backend, bank.id, uncat.id, "LIDL groceries", "50");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Uncategorized" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(0);
  });
});

describe("applyReinterpret", () => {
  it("voids original and creates new entry with correct account", async () => {
    const { backend, bank, uncat } = await setupBackend();
    const { entryId } = await postEntry(backend, bank.id, uncat.id, "LIDL groceries", "50");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(1);

    const applyResult = await applyReinterpret(backend, result.candidates);
    expect(applyResult.applied).toBe(1);
    expect(applyResult.errors).toHaveLength(0);

    // Original entry should be voided
    const [originalEntry] = (await backend.getJournalEntry(entryId))!;
    expect(originalEntry.voided_by).not.toBeNull();

    // New entry should have the groceries account
    const allEntries = await backend.queryJournalEntries({});
    const active = allEntries.filter(([e]) => !e.voided_by);
    // Should have the new reinterpreted entry (others are reversal + new)
    const newEntry = active.find(([e]) => e.description === "LIDL groceries" && e.id !== entryId);
    expect(newEntry).toBeDefined();

    const accounts = await backend.listAccounts();
    const accMap = new Map(accounts.map(a => [a.id, a.full_name]));
    const newItems = newEntry![1];
    const accountNames = newItems.map(i => accMap.get(i.account_id));
    expect(accountNames).toContain("Expenses:Groceries");
    expect(accountNames).toContain("Assets:Bank");
  });

  it("preserves metadata and merges rule tags", async () => {
    const { backend, bank, uncat } = await setupBackend();
    const { entryId } = await postEntry(backend, bank.id, uncat.id, "LIDL groceries", "50");

    // Set existing metadata
    await backend.setMetadata(entryId, { [TAGS_META_KEY]: "imported", "source-file": "test.csv" });

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "lidl", account: "Expenses:Groceries", tags: ["groceries", "food"] },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    const applyResult = await applyReinterpret(backend, result.candidates);
    expect(applyResult.applied).toBe(1);

    // Find the new entry
    const allEntries = await backend.queryJournalEntries({});
    const active = allEntries.filter(([e]) => !e.voided_by);
    const newEntry = active.find(([e]) => e.description === "LIDL groceries" && e.id !== entryId);
    expect(newEntry).toBeDefined();

    const meta = await backend.getMetadata(newEntry![0].id);
    expect(meta["source-file"]).toBe("test.csv");
    // Tags should be merged: "imported" + "groceries" + "food"
    expect(meta[TAGS_META_KEY]).toContain("imported");
    expect(meta[TAGS_META_KEY]).toContain("groceries");
    expect(meta[TAGS_META_KEY]).toContain("food");
  });

  it("creates account hierarchy if target account doesn't exist", async () => {
    const { backend, bank, uncat } = await setupBackend();
    await postEntry(backend, bank.id, uncat.id, "EDF electricity", "100");

    const rules: CsvCategorizationRule[] = [
      { id: "r1", pattern: "edf", account: "Expenses:Utilities:Electricity" },
    ];

    const result = await findReinterpretCandidates(backend, rules);
    expect(result.candidates).toHaveLength(1);

    const applyResult = await applyReinterpret(backend, result.candidates);
    expect(applyResult.applied).toBe(1);

    // Verify the new account hierarchy was created
    const accounts = await backend.listAccounts();
    const names = accounts.map(a => a.full_name);
    expect(names).toContain("Expenses:Utilities");
    expect(names).toContain("Expenses:Utilities:Electricity");
  });
});
