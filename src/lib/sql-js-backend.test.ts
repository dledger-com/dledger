import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend, seedBasicLedger, makeEntry, makeLineItem } from "../test/helpers.js";
import type { SqlJsBackend } from "./sql-js-backend.js";

describe("SqlJsBackend", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  // ---- Currency ops ----

  describe("currencies", () => {
    it("lists empty currencies", async () => {
      const currencies = await backend.listCurrencies();
      expect(currencies).toEqual([]);
    });

    it("creates and lists currencies", async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: false });
      const currencies = await backend.listCurrencies();
      expect(currencies).toHaveLength(2);
      expect(currencies[0].code).toBe("EUR");
      expect(currencies[1].code).toBe("USD");
    });

    it("throws on duplicate currency", async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      await expect(
        backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: false }),
      ).rejects.toThrow("already exists");
    });
  });

  // ---- Currency hidden ----

  describe("currency hidden", () => {
    it("marks and lists hidden currencies", async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      await backend.createCurrency({ code: "SPAM1", name: "Spam Token", decimal_places: 18, is_base: false });
      await backend.createCurrency({ code: "SPAM2", name: "Another Spam", decimal_places: 18, is_base: false });

      // Initially none hidden
      let hidden = await backend.listHiddenCurrencies();
      expect(hidden).toHaveLength(0);

      // Mark as hidden
      await backend.setCurrencyHidden("SPAM1", true);
      await backend.setCurrencyHidden("SPAM2", true);
      hidden = await backend.listHiddenCurrencies();
      expect(hidden).toEqual(["SPAM1", "SPAM2"]);

      // Unhide one
      await backend.setCurrencyHidden("SPAM1", false);
      hidden = await backend.listHiddenCurrencies();
      expect(hidden).toEqual(["SPAM2"]);

      // is_hidden reflected in listCurrencies
      const currencies = await backend.listCurrencies();
      const spam2 = currencies.find((c) => c.code === "SPAM2");
      expect(spam2?.is_hidden).toBe(true);
      const usd = currencies.find((c) => c.code === "USD");
      expect(usd?.is_hidden).toBe(false);
    });

    it("clearLedgerData clears hidden currencies", async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      await backend.createCurrency({ code: "JUNK", name: "Junk Token", decimal_places: 18, is_base: false });
      await backend.setCurrencyHidden("JUNK", true);

      await backend.clearLedgerData();

      const hidden = await backend.listHiddenCurrencies();
      expect(hidden).toHaveLength(0);
      const currencies = await backend.listCurrencies();
      expect(currencies).toHaveLength(0);
    });
  });

  // ---- Account ops ----

  describe("accounts", () => {
    beforeEach(async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
    });

    it("creates and lists accounts", async () => {
      const id = uuidv7();
      await backend.createAccount({
        id, parent_id: null, account_type: "asset",
        name: "Assets", full_name: "Assets",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
      const accounts = await backend.listAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].full_name).toBe("Assets");
    });

    it("supports parent-child hierarchy with closure table", async () => {
      const parentId = uuidv7();
      await backend.createAccount({
        id: parentId, parent_id: null, account_type: "asset",
        name: "Assets", full_name: "Assets",
        allowed_currencies: [], is_postable: false, is_archived: false,
        created_at: "2024-01-01",
      });
      const childId = uuidv7();
      await backend.createAccount({
        id: childId, parent_id: parentId, account_type: "asset",
        name: "Bank", full_name: "Assets:Bank",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });

      // With-children balance should aggregate child accounts
      const entry = makeEntry();
      const items = [
        makeLineItem(entry.id, childId, "USD", "100"),
        // Need a balancing entry - create an equity account
      ];

      const equityId = uuidv7();
      await backend.createAccount({
        id: equityId, parent_id: null, account_type: "equity",
        name: "Equity", full_name: "Equity",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
      items.push(makeLineItem(entry.id, equityId, "USD", "-100"));

      await backend.postJournalEntry(entry, items);

      const parentBalance = await backend.getAccountBalanceWithChildren(parentId);
      expect(parentBalance).toHaveLength(1);
      expect(parentBalance[0].amount).toBe("100");
    });

    it("archives an account", async () => {
      const id = uuidv7();
      await backend.createAccount({
        id, parent_id: null, account_type: "asset",
        name: "Old", full_name: "Old",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
      await backend.archiveAccount(id);
      const account = await backend.getAccount(id);
      expect(account?.is_archived).toBe(true);
    });

    it("throws on duplicate full_name", async () => {
      const id1 = uuidv7();
      await backend.createAccount({
        id: id1, parent_id: null, account_type: "asset",
        name: "Assets", full_name: "Assets",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
      await expect(
        backend.createAccount({
          id: uuidv7(), parent_id: null, account_type: "asset",
          name: "Assets", full_name: "Assets",
          allowed_currencies: [], is_postable: true, is_archived: false,
          created_at: "2024-01-01",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  // ---- Journal entries ----

  describe("journal entries", () => {
    let bankId: string;
    let equityId: string;

    beforeEach(async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      bankId = uuidv7();
      await backend.createAccount({
        id: bankId, parent_id: null, account_type: "asset",
        name: "Bank", full_name: "Assets:Bank",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
      equityId = uuidv7();
      await backend.createAccount({
        id: equityId, parent_id: null, account_type: "equity",
        name: "Opening", full_name: "Equity:Opening",
        allowed_currencies: [], is_postable: true, is_archived: false,
        created_at: "2024-01-01",
      });
    });

    it("posts and retrieves a journal entry", async () => {
      const entry = makeEntry({ description: "Test posting" });
      const items = [
        makeLineItem(entry.id, bankId, "USD", "100"),
        makeLineItem(entry.id, equityId, "USD", "-100"),
      ];
      await backend.postJournalEntry(entry, items);

      const result = await backend.getJournalEntry(entry.id);
      expect(result).not.toBeNull();
      expect(result![0].description).toBe("Test posting");
      expect(result![1]).toHaveLength(2);
    });

    it("validates balancing per currency", async () => {
      const entry = makeEntry();
      const items = [
        makeLineItem(entry.id, bankId, "USD", "100"),
        makeLineItem(entry.id, equityId, "USD", "-50"),
      ];
      await expect(backend.postJournalEntry(entry, items)).rejects.toThrow("does not balance");
    });

    it("rejects zero amount", async () => {
      const entry = makeEntry();
      const items = [
        makeLineItem(entry.id, bankId, "USD", "0"),
        makeLineItem(entry.id, equityId, "USD", "0"),
      ];
      await expect(backend.postJournalEntry(entry, items)).rejects.toThrow("cannot be zero");
    });

    it("rejects nonexistent account", async () => {
      const entry = makeEntry();
      const items = [
        makeLineItem(entry.id, uuidv7(), "USD", "100"),
        makeLineItem(entry.id, equityId, "USD", "-100"),
      ];
      await expect(backend.postJournalEntry(entry, items)).rejects.toThrow("does not exist");
    });

    it("rejects nonexistent currency", async () => {
      const entry = makeEntry();
      const items = [
        makeLineItem(entry.id, bankId, "GBP", "100"),
        makeLineItem(entry.id, equityId, "GBP", "-100"),
      ];
      await expect(backend.postJournalEntry(entry, items)).rejects.toThrow("does not exist");
    });

    it("voiding creates reversal entry", async () => {
      const entry = makeEntry({ description: "Will void" });
      const items = [
        makeLineItem(entry.id, bankId, "USD", "100"),
        makeLineItem(entry.id, equityId, "USD", "-100"),
      ];
      await backend.postJournalEntry(entry, items);

      const reversal = await backend.voidJournalEntry(entry.id);
      expect(reversal.description).toContain("Reversal of");

      const voided = await backend.getJournalEntry(entry.id);
      expect(voided![0].status).toBe("voided");

      // Balance should be zero after void
      const balance = await backend.getAccountBalance(bankId);
      if (balance.length > 0) {
        expect(parseFloat(balance[0].amount)).toBe(0);
      }
    });
  });

  // ---- Queries ----

  describe("queries", () => {
    it("filters by date range", async () => {
      const { backend: b, accounts } = await seedBasicLedger();
      const results = await b.queryJournalEntries({ from_date: "2024-01-10", to_date: "2024-01-16" });
      expect(results).toHaveLength(1);
      expect(results[0][0].description).toBe("Salary January");
    });

    it("filters by account_id", async () => {
      const { backend: b, accounts } = await seedBasicLedger();
      const results = await b.queryJournalEntries({ account_id: accounts.food.id });
      expect(results).toHaveLength(1);
      expect(results[0][0].description).toBe("Groceries");
    });

    it("respects limit and offset", async () => {
      const { backend: b } = await seedBasicLedger();
      const page1 = await b.queryJournalEntries({ limit: 1 });
      expect(page1).toHaveLength(1);

      const page2 = await b.queryJournalEntries({ limit: 1, offset: 1 });
      expect(page2).toHaveLength(1);
      expect(page2[0][0].id).not.toBe(page1[0][0].id);
    });

    it("filters by tag_filters", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      // Tag first entry with "groceries" and second with "groceries,salary"
      await b.setMetadata(allEntries[0][0].id, { tags: "groceries" });
      await b.setMetadata(allEntries[1][0].id, { tags: "groceries,salary" });

      // Filter by single tag
      const tagged = await b.queryJournalEntries({ tag_filters: ["groceries"] });
      expect(tagged).toHaveLength(2);

      // Filter by tag that only one entry has
      const salaryOnly = await b.queryJournalEntries({ tag_filters: ["salary"] });
      expect(salaryOnly).toHaveLength(1);
      expect(salaryOnly[0][0].id).toBe(allEntries[1][0].id);

      // Filter by multiple tags (AND): only entry with both
      const both = await b.queryJournalEntries({ tag_filters: ["groceries", "salary"] });
      expect(both).toHaveLength(1);
      expect(both[0][0].id).toBe(allEntries[1][0].id);

      // Non-existent tag
      const none = await b.queryJournalEntries({ tag_filters: ["nonexistent"] });
      expect(none).toHaveLength(0);
    });

    it("countJournalEntries respects tag_filters", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      await b.setMetadata(allEntries[0][0].id, { tags: "food" });

      const count = await b.countJournalEntries({ tag_filters: ["food"] });
      expect(count).toBe(1);

      const countAll = await b.countJournalEntries({});
      expect(countAll).toBe(allEntries.length);
    });

    it("filters by link_filters", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      await b.setEntryLinks(allEntries[0][0].id, ["invoice-001"]);
      await b.setEntryLinks(allEntries[1][0].id, ["invoice-001", "receipt-42"]);

      // Filter by single link
      const linked = await b.queryJournalEntries({ link_filters: ["invoice-001"] });
      expect(linked).toHaveLength(2);

      // Filter by link that only one entry has
      const receiptOnly = await b.queryJournalEntries({ link_filters: ["receipt-42"] });
      expect(receiptOnly).toHaveLength(1);
      expect(receiptOnly[0][0].id).toBe(allEntries[1][0].id);

      // Filter by multiple links (AND)
      const both = await b.queryJournalEntries({ link_filters: ["invoice-001", "receipt-42"] });
      expect(both).toHaveLength(1);
      expect(both[0][0].id).toBe(allEntries[1][0].id);

      // Non-existent link
      const none = await b.queryJournalEntries({ link_filters: ["nope"] });
      expect(none).toHaveLength(0);
    });

    it("countJournalEntries respects link_filters", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      await b.setEntryLinks(allEntries[0][0].id, ["ref-abc"]);

      const count = await b.countJournalEntries({ link_filters: ["ref-abc"] });
      expect(count).toBe(1);
    });

    it("combines tag_filters and link_filters", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      await b.setMetadata(allEntries[0][0].id, { tags: "important" });
      await b.setEntryLinks(allEntries[0][0].id, ["ref-1"]);
      await b.setMetadata(allEntries[1][0].id, { tags: "important" });

      // Both tag and link must match
      const combined = await b.queryJournalEntries({ tag_filters: ["important"], link_filters: ["ref-1"] });
      expect(combined).toHaveLength(1);
      expect(combined[0][0].id).toBe(allEntries[0][0].id);
    });

    it("tag_filters are case-insensitive", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      await b.setMetadata(allEntries[0][0].id, { tags: "MyTag" });

      const results = await b.queryJournalEntries({ tag_filters: ["mytag"] });
      expect(results).toHaveLength(1);

      const results2 = await b.queryJournalEntries({ tag_filters: ["MYTAG"] });
      expect(results2).toHaveLength(1);
    });

    it("tag_filters with pagination", async () => {
      const { backend: b } = await seedBasicLedger();
      const allEntries = await b.queryJournalEntries({});
      // Tag all entries
      for (const [entry] of allEntries) {
        await b.setMetadata(entry.id, { tags: "all" });
      }
      // Tag just the first one with a unique tag
      await b.setMetadata(allEntries[0][0].id, { tags: "all,unique" });

      // Paginated query with tag filter should respect both
      const count = await b.countJournalEntries({ tag_filters: ["unique"] });
      expect(count).toBe(1);
      const page = await b.queryJournalEntries({ tag_filters: ["unique"], limit: 10, offset: 0 });
      expect(page).toHaveLength(1);
    });
  });

  // ---- Balances ----

  describe("balances", () => {
    it("computes correct account balance", async () => {
      const { backend: b, accounts } = await seedBasicLedger();
      const balance = await b.getAccountBalance(accounts.bank.id);
      // 1000 + 3000 - 50 = 3950
      expect(balance).toHaveLength(1);
      expect(balance[0].amount).toBe("3950");
    });

    it("respects as_of date", async () => {
      const { backend: b, accounts } = await seedBasicLedger();
      // Before Jan 15 salary, only opening balance
      const balance = await b.getAccountBalance(accounts.bank.id, "2024-01-10");
      expect(balance).toHaveLength(1);
      expect(balance[0].amount).toBe("1000");
    });

    it("aggregates with children", async () => {
      const { backend: b } = await seedBasicLedger();
      // Assets parent should aggregate Assets:Bank
      const accounts = await b.listAccounts();
      const assetsParent = accounts.find((a) => a.full_name === "Assets")!;
      const balance = await b.getAccountBalanceWithChildren(assetsParent.id);
      expect(balance).toHaveLength(1);
      expect(balance[0].amount).toBe("3950");
    });
  });

  // ---- Reports ----

  describe("reports", () => {
    it("trial balance debits equal credits", async () => {
      const { backend: b } = await seedBasicLedger();
      const tb = await b.trialBalance("2024-12-31");
      expect(tb.lines.length).toBeGreaterThan(0);

      // Total debits should equal total credits per currency
      for (const debit of tb.total_debits) {
        const credit = tb.total_credits.find((c) => c.currency === debit.currency);
        expect(credit).toBeDefined();
        expect(parseFloat(debit.amount)).toBeCloseTo(parseFloat(credit!.amount), 2);
      }
    });

    it("income statement filters by period", async () => {
      const { backend: b } = await seedBasicLedger();
      const is = await b.incomeStatement("2024-01-01", "2024-02-01");
      // Should have revenue and expense lines
      expect(is.revenue.lines.length).toBeGreaterThan(0);
      expect(is.expenses.lines.length).toBeGreaterThan(0);
    });

    it("balance sheet has correct sections", async () => {
      const { backend: b } = await seedBasicLedger();
      const bs = await b.balanceSheet("2024-12-31");
      expect(bs.assets.lines.length).toBeGreaterThan(0);
      expect(bs.equity.lines.length).toBeGreaterThan(0);
    });

    it("gain/loss report returns empty for no disposals", async () => {
      const { backend: b } = await seedBasicLedger();
      const gl = await b.gainLossReport("2024-01-01", "2024-12-31");
      expect(gl.lines).toHaveLength(0);
      expect(gl.total_gain_loss).toBe("0");
    });
  });

  // ---- Exchange rates ----

  describe("exchange rates", () => {
    beforeEach(async () => {
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
      await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: false });
    });

    it("records and retrieves exchange rate", async () => {
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "manual",
      });
      const rate = await backend.getExchangeRate("EUR", "USD", "2024-01-01");
      expect(rate).toBe("1.10");
    });

    it("derives inverse rate", async () => {
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "manual",
      });
      const rate = await backend.getExchangeRate("USD", "EUR", "2024-01-01");
      expect(rate).not.toBeNull();
      expect(parseFloat(rate!)).toBeCloseTo(1 / 1.1, 6);
    });

    it("derives transitive rate via shared base currency", async () => {
      await backend.createCurrency({ code: "GLD", name: "Gold", decimal_places: 4, is_base: false });
      // EUR→USD and GLD→USD on same date
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "GLD", to_currency: "USD",
        rate: "2000", source: "api",
      });
      // EUR→GLD = (EUR→USD) * (1 / GLD→USD) = 1.10 / 2000 = 0.00055
      const rate = await backend.getExchangeRate("EUR", "GLD", "2024-01-15");
      expect(rate).not.toBeNull();
      expect(parseFloat(rate!)).toBeCloseTo(1.10 / 2000, 8);
    });

    it("derives transitive rate with inverse second leg", async () => {
      await backend.createCurrency({ code: "GLD", name: "Gold", decimal_places: 4, is_base: false });
      // EUR→USD and USD→GLD on same date
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "USD", to_currency: "GLD",
        rate: "0.0005", source: "api",
      });
      // EUR→GLD = (EUR→USD) * (USD→GLD) = 1.10 * 0.0005 = 0.00055
      const rate = await backend.getExchangeRate("EUR", "GLD", "2024-01-15");
      expect(rate).not.toBeNull();
      expect(parseFloat(rate!)).toBeCloseTo(1.10 * 0.0005, 8);
    });

    it("prefers direct rate over transitive", async () => {
      await backend.createCurrency({ code: "GLD", name: "Gold", decimal_places: 4, is_base: false });
      // Direct EUR→GLD rate
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "GLD",
        rate: "0.00060", source: "manual",
      });
      // Also set up transitive path EUR→USD→GLD
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "USD", to_currency: "GLD",
        rate: "0.0005", source: "api",
      });
      // Direct rate should be used, not transitive
      const rate = await backend.getExchangeRate("EUR", "GLD", "2024-01-15");
      expect(rate).toBe("0.00060");
    });

    it("does not derive transitive rate across different dates", async () => {
      await backend.createCurrency({ code: "GLD", name: "Gold", decimal_places: 4, is_base: false });
      // EUR→USD on 2024-01-15, GLD→USD on 2024-01-10 (different dates)
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-10",
        from_currency: "GLD", to_currency: "USD",
        rate: "2000", source: "api",
      });
      const rate = await backend.getExchangeRate("EUR", "GLD", "2024-01-15");
      expect(rate).toBeNull();
    });

    it("does not derive transitive rate when no path exists", async () => {
      await backend.createCurrency({ code: "GBP", name: "British Pound", decimal_places: 2, is_base: false });
      await backend.createCurrency({ code: "JPY", name: "Yen", decimal_places: 0, is_base: false });
      // EUR→USD exists, JPY→GBP exists — no path from EUR to GBP
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-15",
        from_currency: "JPY", to_currency: "GBP",
        rate: "0.005", source: "api",
      });
      const rate = await backend.getExchangeRate("EUR", "GBP", "2024-01-15");
      expect(rate).toBeNull();
    });

    it("respects source priority", async () => {
      // First record API rate
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "api",
      });
      // Then manual rate should overwrite
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.15", source: "manual",
      });
      const rate = await backend.getExchangeRate("EUR", "USD", "2024-01-01");
      expect(rate).toBe("1.15");

      // API rate should NOT overwrite manual
      await backend.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.20", source: "api",
      });
      const rate2 = await backend.getExchangeRate("EUR", "USD", "2024-01-01");
      expect(rate2).toBe("1.15");
    });
  });

  // ---- Ledger import/export ----

  describe("ledger import/export", () => {
    it("imports a beancount file", async () => {
      const content = `
2024-01-01 open Assets:Bank USD
2024-01-01 open Equity:Opening USD

2024-01-01 * "Opening balance"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      const result = await backend.importLedgerFile(content);
      expect(result.transactions_imported).toBe(1);
      expect(result.accounts_created).toBeGreaterThanOrEqual(2);
    });

    it("round-trips export then import", async () => {
      const { backend: b } = await seedBasicLedger();
      const exported = await b.exportLedgerFile();
      expect(exported).toContain("Opening balance");
      expect(exported).toContain("Assets:Bank");

      // Import into fresh backend
      const fresh = await createTestBackend();
      const result = await fresh.importLedgerFile(exported);
      expect(result.transactions_imported).toBe(3);
    });
  });

  // ---- Data management ----

  describe("currency rate sources", () => {
    it("starts with no rate sources", async () => {
      const rows = await backend.getCurrencyRateSources();
      expect(rows).toHaveLength(0);
    });

    it("inserts and retrieves a rate source", async () => {
      await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });
      const inserted = await backend.setCurrencyRateSource("BTC", "coingecko", "auto");
      expect(inserted).toBe(true);
      const rows = await backend.getCurrencyRateSources();
      expect(rows).toHaveLength(1);
      expect(rows[0].currency).toBe("BTC");
      expect(rows[0].rate_source).toBe("coingecko");
      expect(rows[0].set_by).toBe("auto");
    });

    it("auto does not overwrite handler", async () => {
      await backend.createCurrency({ code: "ETH", name: "Ethereum", decimal_places: 18, is_base: false });
      await backend.setCurrencyRateSource("ETH", "none", "handler:pendle");
      const skipped = await backend.setCurrencyRateSource("ETH", "coingecko", "auto");
      expect(skipped).toBe(false);
      const rows = await backend.getCurrencyRateSources();
      const eth = rows.find((r) => r.currency === "ETH");
      expect(eth?.rate_source).toBe("none");
      expect(eth?.set_by).toBe("handler:pendle");
    });

    it("handler does not overwrite user", async () => {
      await backend.createCurrency({ code: "SOL", name: "Solana", decimal_places: 9, is_base: false });
      await backend.setCurrencyRateSource("SOL", "coingecko", "user");
      const skipped = await backend.setCurrencyRateSource("SOL", "finnhub", "handler:test");
      expect(skipped).toBe(false);
      const rows = await backend.getCurrencyRateSources();
      const sol = rows.find((r) => r.currency === "SOL");
      expect(sol?.rate_source).toBe("coingecko");
      expect(sol?.set_by).toBe("user");
    });

    it("user overwrites handler", async () => {
      await backend.createCurrency({ code: "DOT", name: "Polkadot", decimal_places: 10, is_base: false });
      await backend.setCurrencyRateSource("DOT", "none", "handler:test");
      const updated = await backend.setCurrencyRateSource("DOT", "coingecko", "user");
      expect(updated).toBe(true);
      const rows = await backend.getCurrencyRateSources();
      const dot = rows.find((r) => r.currency === "DOT");
      expect(dot?.rate_source).toBe("coingecko");
      expect(dot?.set_by).toBe("user");
    });

    it("user overwrites auto", async () => {
      await backend.createCurrency({ code: "ADA", name: "Cardano", decimal_places: 6, is_base: false });
      await backend.setCurrencyRateSource("ADA", "coingecko", "auto");
      const updated = await backend.setCurrencyRateSource("ADA", "finnhub", "user");
      expect(updated).toBe(true);
      const rows = await backend.getCurrencyRateSources();
      const ada = rows.find((r) => r.currency === "ADA");
      expect(ada?.rate_source).toBe("finnhub");
      expect(ada?.set_by).toBe("user");
    });

    it("handler overwrites auto", async () => {
      await backend.createCurrency({ code: "LINK", name: "Chainlink", decimal_places: 18, is_base: false });
      await backend.setCurrencyRateSource("LINK", "coingecko", "auto");
      const updated = await backend.setCurrencyRateSource("LINK", "none", "handler:test");
      expect(updated).toBe(true);
      const rows = await backend.getCurrencyRateSources();
      const link = rows.find((r) => r.currency === "LINK");
      expect(link?.rate_source).toBe("none");
      expect(link?.set_by).toBe("handler:test");
    });

    it("clearAutoRateSources removes only auto entries", async () => {
      await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });
      await backend.createCurrency({ code: "ETH", name: "Ethereum", decimal_places: 18, is_base: false });
      await backend.createCurrency({ code: "SOL", name: "Solana", decimal_places: 9, is_base: false });
      await backend.setCurrencyRateSource("BTC", "coingecko", "auto");
      await backend.setCurrencyRateSource("ETH", "none", "handler:pendle");
      await backend.setCurrencyRateSource("SOL", "coingecko", "user");

      await backend.clearAutoRateSources();
      const rows = await backend.getCurrencyRateSources();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.currency).sort()).toEqual(["ETH", "SOL"]);
    });

    it("clearNonUserRateSources keeps only user entries", async () => {
      await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });
      await backend.createCurrency({ code: "ETH", name: "Ethereum", decimal_places: 18, is_base: false });
      await backend.createCurrency({ code: "SOL", name: "Solana", decimal_places: 9, is_base: false });
      await backend.setCurrencyRateSource("BTC", "coingecko", "auto");
      await backend.setCurrencyRateSource("ETH", "none", "handler:pendle");
      await backend.setCurrencyRateSource("SOL", "coingecko", "user");

      await backend.clearNonUserRateSources();
      const rows = await backend.getCurrencyRateSources();
      expect(rows).toHaveLength(1);
      expect(rows[0].currency).toBe("SOL");
      expect(rows[0].set_by).toBe("user");
    });

    it("setCurrencyRateSource with null clears rate_source", async () => {
      await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });
      await backend.setCurrencyRateSource("BTC", "coingecko", "user");
      await backend.setCurrencyRateSource("BTC", null, "user");
      const rows = await backend.getCurrencyRateSources();
      const btc = rows.find((r) => r.currency === "BTC");
      expect(btc?.rate_source).toBeNull();
    });
  });

  describe("data management", () => {
    it("clearLedgerData preserves exchange rates", async () => {
      const { backend: b } = await seedBasicLedger();
      await b.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "manual",
      });

      await b.clearLedgerData();

      const entries = await b.queryJournalEntries({});
      expect(entries).toHaveLength(0);

      const rates = await b.listExchangeRates();
      expect(rates).toHaveLength(1);
    });

    it("clearAllData removes everything", async () => {
      const { backend: b } = await seedBasicLedger();
      await b.recordExchangeRate({
        id: uuidv7(), date: "2024-01-01",
        from_currency: "EUR", to_currency: "USD",
        rate: "1.10", source: "manual",
      });

      await b.clearAllData();

      const entries = await b.queryJournalEntries({});
      expect(entries).toHaveLength(0);
      const rates = await b.listExchangeRates();
      expect(rates).toHaveLength(0);
      const currencies = await b.listCurrencies();
      expect(currencies).toHaveLength(0);
    });
  });

  // ---- Currency token addresses ----

  describe("currency token addresses", () => {
    it("stores and retrieves token addresses", async () => {
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      await backend.setCurrencyTokenAddress("WETH", "ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");

      const all = await backend.getCurrencyTokenAddresses();
      expect(all).toHaveLength(2);
      expect(all.find((t) => t.currency === "USDC")?.contract_address).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");

      const single = await backend.getCurrencyTokenAddress("WETH");
      expect(single).not.toBeNull();
      expect(single!.chain).toBe("ethereum");
      expect(single!.contract_address).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    });

    it("returns null for unknown currency", async () => {
      const result = await backend.getCurrencyTokenAddress("UNKNOWN");
      expect(result).toBeNull();
    });

    it("INSERT OR IGNORE keeps first-seen address (same currency, different chain)", async () => {
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xeth_address");
      await backend.setCurrencyTokenAddress("USDC", "arbitrum", "0xarb_address");

      const all = await backend.getCurrencyTokenAddresses();
      expect(all).toHaveLength(2);

      // getCurrencyTokenAddress returns first row (first-seen chain)
      const single = await backend.getCurrencyTokenAddress("USDC");
      expect(single).not.toBeNull();
    });

    it("INSERT OR IGNORE ignores duplicate (same currency + chain)", async () => {
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xoriginal");
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xduplicate");

      const all = await backend.getCurrencyTokenAddresses();
      const ethUsdc = all.filter((t) => t.currency === "USDC" && t.chain === "ethereum");
      expect(ethUsdc).toHaveLength(1);
      expect(ethUsdc[0].contract_address).toBe("0xoriginal");
    });

    it("clearLedgerData clears token addresses", async () => {
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xaddress");
      await backend.clearLedgerData();
      const all = await backend.getCurrencyTokenAddresses();
      expect(all).toHaveLength(0);
    });

    it("clearAllData clears token addresses", async () => {
      await backend.setCurrencyTokenAddress("USDC", "ethereum", "0xaddress");
      await backend.clearAllData();
      const all = await backend.getCurrencyTokenAddresses();
      expect(all).toHaveLength(0);
    });
  });

  // ---- Entry links ----

  describe("entry links", () => {
    async function seedEntry(desc = "Test entry"): Promise<string> {
      // Ensure currency + accounts exist (idempotent: catch dups)
      await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true }).catch(() => {});
      const accounts = await backend.listAccounts();
      let assetId: string, expenseId: string;
      const existingAsset = accounts.find(a => a.full_name === "Assets");
      const existingExpense = accounts.find(a => a.full_name === "Expenses");
      if (existingAsset) {
        assetId = existingAsset.id;
      } else {
        const a = { id: uuidv7(), parent_id: null, account_type: "asset" as const, name: "Assets", full_name: "Assets", allowed_currencies: [] as string[], is_postable: true, is_archived: false, created_at: "2024-01-01" };
        await backend.createAccount(a);
        assetId = a.id;
      }
      if (existingExpense) {
        expenseId = existingExpense.id;
      } else {
        const e = { id: uuidv7(), parent_id: null, account_type: "expense" as const, name: "Expenses", full_name: "Expenses", allowed_currencies: [] as string[], is_postable: true, is_archived: false, created_at: "2024-01-01" };
        await backend.createAccount(e);
        expenseId = e.id;
      }
      const entry = makeEntry({ description: desc });
      const items = [
        makeLineItem(entry.id, assetId, "USD", "-100"),
        makeLineItem(entry.id, expenseId, "USD", "100"),
      ];
      await backend.postJournalEntry(entry, items);
      return entry.id;
    }

    it("returns empty links for entry with no links", async () => {
      const id = await seedEntry();
      const links = await backend.getEntryLinks(id);
      expect(links).toEqual([]);
    });

    it("sets and gets entry links", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["invoice-jan", "payment-batch"]);
      const links = await backend.getEntryLinks(id);
      expect(links).toEqual(["invoice-jan", "payment-batch"]);
    });

    it("normalizes link names (lowercase, trim)", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["  Invoice-JAN  ", "PAYMENT"]);
      const links = await backend.getEntryLinks(id);
      expect(links).toEqual(["invoice-jan", "payment"]);
    });

    it("replaces links on subsequent set", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["link1", "link2"]);
      await backend.setEntryLinks(id, ["link3"]);
      const links = await backend.getEntryLinks(id);
      expect(links).toEqual(["link3"]);
    });

    it("clears links when set to empty array", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["link1"]);
      await backend.setEntryLinks(id, []);
      const links = await backend.getEntryLinks(id);
      expect(links).toEqual([]);
    });

    it("getEntriesByLink returns entry IDs for a link", async () => {
      const id1 = await seedEntry("Entry 1");
      const id2 = await seedEntry("Entry 2");
      await backend.setEntryLinks(id1, ["shared-link"]);
      await backend.setEntryLinks(id2, ["shared-link", "other"]);
      const entryIds = await backend.getEntriesByLink("shared-link");
      expect(entryIds).toHaveLength(2);
      expect(entryIds).toContain(id1);
      expect(entryIds).toContain(id2);
    });

    it("getEntriesByLink excludes voided entries", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["mylink"]);
      await backend.voidJournalEntry(id);
      const entryIds = await backend.getEntriesByLink("mylink");
      expect(entryIds).not.toContain(id);
    });

    it("getAllLinkNames returns distinct link names", async () => {
      const id1 = await seedEntry("E1");
      const id2 = await seedEntry("E2");
      await backend.setEntryLinks(id1, ["alpha", "beta"]);
      await backend.setEntryLinks(id2, ["beta", "gamma"]);
      const names = await backend.getAllLinkNames();
      expect(names).toEqual(["alpha", "beta", "gamma"]);
    });

    it("getAllLinksWithCounts returns counts excluding voided", async () => {
      const id1 = await seedEntry("E1");
      const id2 = await seedEntry("E2");
      await backend.setEntryLinks(id1, ["invoice"]);
      await backend.setEntryLinks(id2, ["invoice"]);
      await backend.voidJournalEntry(id2);
      const counts = await backend.getAllLinksWithCounts();
      const invoiceCount = counts.find(c => c.link_name === "invoice");
      expect(invoiceCount?.entry_count).toBe(1);
    });

    it("clearLedgerData clears entry links", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["mylink"]);
      await backend.clearLedgerData();
      const names = await backend.getAllLinkNames();
      expect(names).toHaveLength(0);
    });

    it("clearAllData clears entry links", async () => {
      const id = await seedEntry();
      await backend.setEntryLinks(id, ["mylink"]);
      await backend.clearAllData();
      const names = await backend.getAllLinkNames();
      expect(names).toHaveLength(0);
    });

    it("getMetadataBatch returns grouped map for multiple entries", async () => {
      const id1 = await seedEntry("Entry 1");
      const id2 = await seedEntry("Entry 2");
      await backend.setMetadata(id1, { tags: "foo,bar", source: "csv" });
      await backend.setMetadata(id2, { tags: "baz" });
      const result = await backend.getMetadataBatch([id1, id2]);
      expect(result.get(id1)).toEqual({ tags: "foo,bar", source: "csv" });
      expect(result.get(id2)).toEqual({ tags: "baz" });
    });

    it("getMetadataBatch returns empty map for empty input", async () => {
      const result = await backend.getMetadataBatch([]);
      expect(result.size).toBe(0);
    });

    it("getMetadataBatch omits entries with no metadata", async () => {
      const id = await seedEntry("No meta");
      const result = await backend.getMetadataBatch([id]);
      expect(result.has(id)).toBe(false);
    });

    it("getEntryLinksBatch returns grouped map for multiple entries", async () => {
      const id1 = await seedEntry("Entry 1");
      const id2 = await seedEntry("Entry 2");
      const id3 = await seedEntry("Entry 3");
      await backend.setEntryLinks(id1, ["alpha", "beta"]);
      await backend.setEntryLinks(id2, ["gamma"]);
      const result = await backend.getEntryLinksBatch([id1, id2, id3]);
      expect(result.get(id1)).toEqual(["alpha", "beta"]);
      expect(result.get(id2)).toEqual(["gamma"]);
      expect(result.has(id3)).toBe(false);
    });

    it("getEntryLinksBatch returns empty map for empty input", async () => {
      const result = await backend.getEntryLinksBatch([]);
      expect(result.size).toBe(0);
    });
  });
});
