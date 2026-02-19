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
});
