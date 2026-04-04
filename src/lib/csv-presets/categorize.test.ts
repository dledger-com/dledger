import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { matchRule, buildHistoricalExamples, buildHistoricalTagExamples, applyRuleTags, type CsvCategorizationRule } from "./categorize.js";
import { createTestBackend } from "../../test/helpers.js";
import type { Account, JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvRecord } from "./types.js";
import { TAGS_META_KEY, parseTags, serializeTags } from "$lib/utils/tags.js";

const rules: CsvCategorizationRule[] = [
  { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
  { id: "2", pattern: "grocery", account: "Expenses:Groceries" },
  { id: "3", pattern: "salary", account: "Income:Salary" },
  { id: "4", pattern: "amazon", account: "Expenses:Shopping" },
];

describe("matchRule", () => {
  it("matches first matching rule", () => {
    const result = matchRule("Morning coffee at Starbucks", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Coffee");
  });

  it("is case-insensitive", () => {
    const result = matchRule("COFFEE SHOP", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Coffee");
  });

  it("returns null when no match", () => {
    const result = matchRule("Electric bill payment", rules);
    expect(result).toBeNull();
  });

  it("returns null for empty description", () => {
    const result = matchRule("", rules);
    expect(result).toBeNull();
  });

  it("returns null for empty rules", () => {
    const result = matchRule("coffee", []);
    expect(result).toBeNull();
  });

  it("matches first rule when multiple could match", () => {
    const multiRules: CsvCategorizationRule[] = [
      { id: "1", pattern: "shop", account: "Expenses:Shopping" },
      { id: "2", pattern: "coffee shop", account: "Expenses:Coffee" },
    ];
    const result = matchRule("coffee shop visit", multiRules);
    expect(result!.account).toBe("Expenses:Shopping"); // first match wins
  });

  it("matches substring anywhere in description", () => {
    const result = matchRule("payment at Amazon.com for books", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Shopping");
  });

  it("skips rules with empty pattern", () => {
    const rulesWithEmpty: CsvCategorizationRule[] = [
      { id: "1", pattern: "", account: "Expenses:Misc" },
      { id: "2", pattern: "coffee", account: "Expenses:Coffee" },
    ];
    const result = matchRule("coffee", rulesWithEmpty);
    expect(result!.account).toBe("Expenses:Coffee");
  });
});

describe("buildHistoricalExamples", () => {
  async function setupAccounts(backend: Awaited<ReturnType<typeof createTestBackend>>) {
    const USD = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 };
    await backend.createCurrency(USD);

    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId, parent_id: null, account_type: "asset",
      name: "Assets", full_name: "Assets",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });

    const expensesId = uuidv7();
    await backend.createAccount({
      id: expensesId, parent_id: null, account_type: "expense",
      name: "Expenses", full_name: "Expenses",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });

    const bank: Account = {
      id: uuidv7(), parent_id: assetsId, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    };
    await backend.createAccount(bank);

    const groceries: Account = {
      id: uuidv7(), parent_id: expensesId, account_type: "expense",
      name: "Groceries", full_name: "Expenses:Groceries",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    };
    await backend.createAccount(groceries);

    const rent: Account = {
      id: uuidv7(), parent_id: expensesId, account_type: "expense",
      name: "Rent", full_name: "Expenses:Rent",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    };
    await backend.createAccount(rent);

    return { bank, groceries, rent };
  }

  async function postEntry(
    backend: Awaited<ReturnType<typeof createTestBackend>>,
    description: string,
    debitAccountId: string,
    creditAccountId: string,
    status: "confirmed" | "voided" = "confirmed",
  ) {
    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId, date: "2024-06-15", description,
      status, source: "manual", voided_by: null, created_at: "2024-06-15",
    };
    const items: LineItem[] = [
      { id: uuidv7(), journal_entry_id: entryId, account_id: debitAccountId, currency: "USD", amount: "100", lot_id: null },
      { id: uuidv7(), journal_entry_id: entryId, account_id: creditAccountId, currency: "USD", amount: "-100", lot_id: null },
    ];
    await backend.postJournalEntry(entry, items);
  }

  it("returns empty array for empty journal", async () => {
    const backend = await createTestBackend();
    const result = await buildHistoricalExamples(backend);
    expect(result).toEqual([]);
  });

  it("groups descriptions by account", async () => {
    const backend = await createTestBackend();
    const { bank, groceries, rent } = await setupAccounts(backend);

    await postEntry(backend, "LIDL PARIS 15", groceries.id, bank.id);
    await postEntry(backend, "ALDI BERLIN", groceries.id, bank.id);
    await postEntry(backend, "Monthly rent payment", rent.id, bank.id);

    const examples = await buildHistoricalExamples(backend);

    // Should have entries for bank, groceries, and rent (each entry touches 2 accounts)
    const groceryEx = examples.find((e) => e.account === "Expenses:Groceries");
    expect(groceryEx).toBeDefined();
    expect(groceryEx!.descriptions).toContain("LIDL PARIS 15");
    expect(groceryEx!.descriptions).toContain("ALDI BERLIN");
    expect(groceryEx!.descriptions).toHaveLength(2);

    const rentEx = examples.find((e) => e.account === "Expenses:Rent");
    expect(rentEx).toBeDefined();
    expect(rentEx!.descriptions).toContain("Monthly rent payment");
    expect(rentEx!.descriptions).toHaveLength(1);
  });

  it("deduplicates descriptions within an account", async () => {
    const backend = await createTestBackend();
    const { bank, groceries } = await setupAccounts(backend);

    await postEntry(backend, "LIDL PARIS 15", groceries.id, bank.id);
    await postEntry(backend, "LIDL PARIS 15", groceries.id, bank.id); // same description

    const examples = await buildHistoricalExamples(backend);
    const groceryEx = examples.find((e) => e.account === "Expenses:Groceries");
    expect(groceryEx).toBeDefined();
    expect(groceryEx!.descriptions).toHaveLength(1); // deduped
  });

  it("caps descriptions per account at maxPerAccount", async () => {
    const backend = await createTestBackend();
    const { bank, groceries } = await setupAccounts(backend);

    // Post 5 entries with unique descriptions
    for (let i = 0; i < 5; i++) {
      await postEntry(backend, `Store purchase ${i}`, groceries.id, bank.id);
    }

    const examples = await buildHistoricalExamples(backend, 500, 3);
    const groceryEx = examples.find((e) => e.account === "Expenses:Groceries");
    expect(groceryEx).toBeDefined();
    expect(groceryEx!.descriptions.length).toBeLessThanOrEqual(3);
  });

  it("skips entries without descriptions", async () => {
    const backend = await createTestBackend();
    const { bank, groceries } = await setupAccounts(backend);

    await postEntry(backend, "", groceries.id, bank.id); // empty description
    await postEntry(backend, "LIDL", groceries.id, bank.id);

    const examples = await buildHistoricalExamples(backend);
    const groceryEx = examples.find((e) => e.account === "Expenses:Groceries");
    expect(groceryEx).toBeDefined();
    expect(groceryEx!.descriptions).toEqual(["LIDL"]);
  });

  it("excludes voided entries", async () => {
    const backend = await createTestBackend();
    const { bank, groceries } = await setupAccounts(backend);

    await postEntry(backend, "Voided purchase", groceries.id, bank.id, "confirmed");

    // Void the entry
    const entries = await backend.queryJournalEntries({ status: "confirmed" });
    expect(entries.length).toBeGreaterThan(0);
    await backend.voidJournalEntry(entries[0][0].id);

    const examples = await buildHistoricalExamples(backend);
    // After voiding, the query for confirmed entries should not include the voided one
    const groceryEx = examples.find((e) => e.account === "Expenses:Groceries");
    // The voided entry should not appear
    if (groceryEx) {
      expect(groceryEx.descriptions).not.toContain("Voided purchase");
    }
  });
});

describe("applyRuleTags", () => {
  function makeRecord(description: string, metadata?: Record<string, string>): CsvRecord {
    return {
      date: "2024-01-01",
      description,
      lines: [
        { account: "Expenses:Uncategorized", currency: "USD", amount: "100" },
        { account: "Assets:Bank", currency: "USD", amount: "-100" },
      ],
      metadata,
    };
  }

  it("applies tags from matching rule", () => {
    const records = [makeRecord("morning coffee")];
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "coffee", account: "Expenses:Coffee", tags: ["food", "daily"] },
    ];
    applyRuleTags(records, rules);
    expect(parseTags(records[0].metadata?.[TAGS_META_KEY])).toEqual(["food", "daily"]);
  });

  it("merges with existing tags", () => {
    const records = [makeRecord("morning coffee", { [TAGS_META_KEY]: "imported" })];
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "coffee", account: "Expenses:Coffee", tags: ["food"] },
    ];
    applyRuleTags(records, rules);
    const tags = parseTags(records[0].metadata?.[TAGS_META_KEY]);
    expect(tags).toContain("imported");
    expect(tags).toContain("food");
  });

  it("does not apply tags when rule has no tags", () => {
    const records = [makeRecord("morning coffee")];
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
    ];
    applyRuleTags(records, rules);
    expect(records[0].metadata?.[TAGS_META_KEY]).toBeUndefined();
  });

  it("does nothing when no rule matches", () => {
    const records = [makeRecord("electric bill")];
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "coffee", account: "Expenses:Coffee", tags: ["food"] },
    ];
    applyRuleTags(records, rules);
    expect(records[0].metadata?.[TAGS_META_KEY]).toBeUndefined();
  });

  it("deduplicates when merging", () => {
    const records = [makeRecord("morning coffee", { [TAGS_META_KEY]: "food" })];
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "coffee", account: "Expenses:Coffee", tags: ["food", "daily"] },
    ];
    applyRuleTags(records, rules);
    const tags = parseTags(records[0].metadata?.[TAGS_META_KEY]);
    expect(tags.filter((t) => t === "food")).toHaveLength(1);
    expect(tags).toContain("daily");
  });
});

describe("buildHistoricalTagExamples", () => {
  async function setupAndPost(backend: Awaited<ReturnType<typeof createTestBackend>>) {
    const USD = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 };
    await backend.createCurrency(USD);

    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId, parent_id: null, account_type: "asset",
      name: "Assets", full_name: "Assets",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const bank: Account = {
      id: uuidv7(), parent_id: assetsId, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    };
    await backend.createAccount(bank);

    const expensesId = uuidv7();
    await backend.createAccount({
      id: expensesId, parent_id: null, account_type: "expense",
      name: "Expenses", full_name: "Expenses",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const groceries: Account = {
      id: uuidv7(), parent_id: expensesId, account_type: "expense",
      name: "Groceries", full_name: "Expenses:Groceries",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    };
    await backend.createAccount(groceries);

    // Post entry with tags
    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId, date: "2024-06-15", description: "LIDL groceries",
      status: "confirmed", source: "manual", voided_by: null, created_at: "2024-06-15",
    };
    const items: LineItem[] = [
      { id: uuidv7(), journal_entry_id: entryId, account_id: groceries.id, currency: "USD", amount: "50", lot_id: null },
      { id: uuidv7(), journal_entry_id: entryId, account_id: bank.id, currency: "USD", amount: "-50", lot_id: null },
    ];
    await backend.postJournalEntry(entry, items);
    await backend.setMetadata(entryId, { [TAGS_META_KEY]: "groceries,food" });

    // Post entry without tags
    const entryId2 = uuidv7();
    const entry2: JournalEntry = {
      id: entryId2, date: "2024-06-16", description: "Rent payment",
      status: "confirmed", source: "manual", voided_by: null, created_at: "2024-06-16",
    };
    const items2: LineItem[] = [
      { id: uuidv7(), journal_entry_id: entryId2, account_id: groceries.id, currency: "USD", amount: "1000", lot_id: null },
      { id: uuidv7(), journal_entry_id: entryId2, account_id: bank.id, currency: "USD", amount: "-1000", lot_id: null },
    ];
    await backend.postJournalEntry(entry2, items2);

    return { bank, groceries };
  }

  it("returns empty for no tagged entries", async () => {
    const backend = await createTestBackend();
    const result = await buildHistoricalTagExamples(backend);
    expect(result).toEqual([]);
  });

  it("returns entries with tags", async () => {
    const backend = await createTestBackend();
    await setupAndPost(backend);

    const result = await buildHistoricalTagExamples(backend);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("LIDL groceries");
    expect(result[0].tags).toEqual(["groceries", "food"]);
  });

  it("skips entries without tags", async () => {
    const backend = await createTestBackend();
    await setupAndPost(backend);

    const result = await buildHistoricalTagExamples(backend);
    const descriptions = result.map((r) => r.description);
    expect(descriptions).not.toContain("Rent payment");
  });
});

describe("getAllTagValues", () => {
  it("returns empty for no metadata", async () => {
    const backend = await createTestBackend();
    const result = await backend.getAllTagValues();
    expect(result).toEqual([]);
  });

  it("returns deduplicated sorted tags", async () => {
    const backend = await createTestBackend();
    const USD = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 };
    await backend.createCurrency(USD);
    const acctId = uuidv7();
    const acctId2 = uuidv7();
    await backend.createAccount({
      id: acctId, parent_id: null, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });
    await backend.createAccount({
      id: acctId2, parent_id: null, account_type: "expense",
      name: "Food", full_name: "Expenses:Food",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });

    // Post two entries with overlapping tags (each entry must balance)
    const e1 = uuidv7();
    await backend.postJournalEntry(
      { id: e1, date: "2024-01-01", description: "A", status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-01" },
      [
        { id: uuidv7(), journal_entry_id: e1, account_id: acctId, currency: "USD", amount: "-100", lot_id: null },
        { id: uuidv7(), journal_entry_id: e1, account_id: acctId2, currency: "USD", amount: "100", lot_id: null },
      ],
    );
    await backend.setMetadata(e1, { [TAGS_META_KEY]: "food,groceries" });

    const e2 = uuidv7();
    await backend.postJournalEntry(
      { id: e2, date: "2024-01-02", description: "B", status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-02" },
      [
        { id: uuidv7(), journal_entry_id: e2, account_id: acctId, currency: "USD", amount: "-50", lot_id: null },
        { id: uuidv7(), journal_entry_id: e2, account_id: acctId2, currency: "USD", amount: "50", lot_id: null },
      ],
    );
    await backend.setMetadata(e2, { [TAGS_META_KEY]: "food,rent" });

    const tags = await backend.getAllTagValues();
    expect(tags).toEqual(["food", "groceries", "rent"]); // sorted, deduplicated
  });
});

describe("getAllMetadataKeys", () => {
  it("returns empty for no metadata", async () => {
    const backend = await createTestBackend();
    const result = await backend.getAllMetadataKeys();
    expect(result).toEqual([]);
  });

  it("returns distinct keys excluding tags", async () => {
    const backend = await createTestBackend();
    const USD = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 };
    await backend.createCurrency(USD);
    const acctId = uuidv7();
    const acctId2 = uuidv7();
    await backend.createAccount({
      id: acctId, parent_id: null, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });
    await backend.createAccount({
      id: acctId2, parent_id: null, account_type: "expense",
      name: "Food", full_name: "Expenses:Food",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });

    const e1 = uuidv7();
    await backend.postJournalEntry(
      { id: e1, date: "2024-01-01", description: "A", status: "confirmed", source: "manual", voided_by: null, created_at: "2024-01-01" },
      [
        { id: uuidv7(), journal_entry_id: e1, account_id: acctId, currency: "USD", amount: "-100", lot_id: null },
        { id: uuidv7(), journal_entry_id: e1, account_id: acctId2, currency: "USD", amount: "100", lot_id: null },
      ],
    );
    await backend.setMetadata(e1, { [TAGS_META_KEY]: "food", "bank-category": "groceries", "source": "n26" });

    const keys = await backend.getAllMetadataKeys();
    expect(keys).toContain("bank-category");
    expect(keys).toContain("source");
    expect(keys).not.toContain("tags");
  });
});
