import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../test/helpers.js";
import type { SqlJsBackend } from "./sql-js-backend.js";
import type { CurrencyDateRequirement } from "./backend.js";
import { findMissingRates } from "./exchange-rate-historical.js";

describe("getCurrencyDateRequirements", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
    await backend.createCurrency({ code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true });
    await backend.createCurrency({ code: "EUR", asset_type: "", param: "", name: "Euro", decimal_places: 2, is_base: false });
    await backend.createCurrency({ code: "BTC", asset_type: "", param: "", name: "Bitcoin", decimal_places: 8, is_base: false });
    await backend.createCurrency({ code: "ETH", asset_type: "", param: "", name: "Ethereum", decimal_places: 8, is_base: false });

    // Create accounts
    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId, parent_id: null, account_type: "asset",
      name: "Assets", full_name: "Assets",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const bankId = uuidv7();
    await backend.createAccount({
      id: bankId, parent_id: assetsId, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });
    const cryptoId = uuidv7();
    await backend.createAccount({
      id: cryptoId, parent_id: assetsId, account_type: "asset",
      name: "Crypto", full_name: "Assets:Crypto",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });

    const expensesId = uuidv7();
    await backend.createAccount({
      id: expensesId, parent_id: null, account_type: "expense",
      name: "Expenses", full_name: "Expenses",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const foodId = uuidv7();
    await backend.createAccount({
      id: foodId, parent_id: expensesId, account_type: "expense",
      name: "Food", full_name: "Expenses:Food",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });

    const incomeId = uuidv7();
    await backend.createAccount({
      id: incomeId, parent_id: null, account_type: "revenue",
      name: "Income", full_name: "Income",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const salaryId = uuidv7();
    await backend.createAccount({
      id: salaryId, parent_id: incomeId, account_type: "revenue",
      name: "Salary", full_name: "Income:Salary",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });

    const equityId = uuidv7();
    await backend.createAccount({
      id: equityId, parent_id: null, account_type: "equity",
      name: "Equity", full_name: "Equity",
      allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
    });
    const openingId = uuidv7();
    await backend.createAccount({
      id: openingId, parent_id: equityId, account_type: "equity",
      name: "Opening", full_name: "Equity:Opening",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });
    const tradingId = uuidv7();
    await backend.createAccount({
      id: tradingId, parent_id: equityId, account_type: "equity",
      name: "Trading", full_name: "Equity:Trading",
      allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
    });
  });

  async function getAccountId(name: string): Promise<string> {
    const accounts = await backend.listAccounts();
    return accounts.find((a) => a.full_name === name)!.id;
  }

  async function postEntry(date: string, description: string, lines: { account: string; currency: string; amount: string }[]) {
    const entryId = uuidv7();
    await backend.postJournalEntry(
      { id: entryId, date, description, status: "confirmed", source: "", voided_by: null, created_at: date },
      await Promise.all(lines.map(async (l) => ({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: await getAccountId(l.account),
        currency: l.currency,
        amount: l.amount,
        lot_id: null,
      }))),
    );
  }

  it("returns range mode for asset currencies", async () => {
    // Buy EUR: debit EUR to bank, credit EUR from trading; debit USD from trading, credit USD from bank
    await postEntry("2024-01-15", "Buy EUR", [
      { account: "Assets:Bank", currency: "EUR", amount: "100" },
      { account: "Equity:Trading", currency: "EUR", amount: "-100" },
      { account: "Equity:Trading", currency: "USD", amount: "110" },
      { account: "Assets:Bank", currency: "USD", amount: "-110" },
    ]);
    await postEntry("2024-06-15", "Buy more EUR", [
      { account: "Assets:Bank", currency: "EUR", amount: "200" },
      { account: "Equity:Trading", currency: "EUR", amount: "-200" },
      { account: "Equity:Trading", currency: "USD", amount: "220" },
      { account: "Assets:Bank", currency: "USD", amount: "-220" },
    ]);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    const eurReq = reqs.find((r) => r.currency === "EUR");
    expect(eurReq).toBeDefined();
    expect(eurReq!.mode).toBe("range");
    expect(eurReq!.firstDate).toBe("2024-01-15");
    expect(eurReq!.lastDate).toBe("2024-06-15");
    expect(eurReq!.hasBalance).toBe(true); // 300 EUR net in assets
    expect(eurReq!.dates).toEqual([]);
  });

  it("returns dates mode for expense-only currencies", async () => {
    await postEntry("2024-03-01", "Groceries in EUR", [
      { account: "Expenses:Food", currency: "EUR", amount: "50" },
      { account: "Equity:Trading", currency: "EUR", amount: "-50" },
      { account: "Equity:Trading", currency: "USD", amount: "55" },
      { account: "Assets:Bank", currency: "USD", amount: "-55" },
    ]);
    await postEntry("2024-07-20", "More groceries in EUR", [
      { account: "Expenses:Food", currency: "EUR", amount: "30" },
      { account: "Equity:Trading", currency: "EUR", amount: "-30" },
      { account: "Equity:Trading", currency: "USD", amount: "33" },
      { account: "Assets:Bank", currency: "USD", amount: "-33" },
    ]);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    const eurReq = reqs.find((r) => r.currency === "EUR");
    expect(eurReq).toBeDefined();
    expect(eurReq!.mode).toBe("dates");
    expect(eurReq!.dates).toContain("2024-03-01");
    expect(eurReq!.dates).toContain("2024-07-20");
  });

  it("range dominates when currency is in both asset and expense", async () => {
    // Asset entry — buy BTC
    await postEntry("2024-01-10", "Buy BTC", [
      { account: "Assets:Crypto", currency: "BTC", amount: "1" },
      { account: "Equity:Trading", currency: "BTC", amount: "-1" },
      { account: "Equity:Trading", currency: "USD", amount: "42000" },
      { account: "Assets:Bank", currency: "USD", amount: "-42000" },
    ]);
    // Expense entry (same currency BTC, different account type)
    await postEntry("2024-05-15", "BTC fee", [
      { account: "Expenses:Food", currency: "BTC", amount: "0.001" },
      { account: "Assets:Crypto", currency: "BTC", amount: "-0.001" },
    ]);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    const btcReq = reqs.find((r) => r.currency === "BTC");
    expect(btcReq).toBeDefined();
    expect(btcReq!.mode).toBe("range");
  });

  it("excludes base currency", async () => {
    await postEntry("2024-01-01", "Test", [
      { account: "Assets:Bank", currency: "USD", amount: "100" },
      { account: "Equity:Opening", currency: "USD", amount: "-100" },
    ]);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    expect(reqs.find((r) => r.currency === "USD")).toBeUndefined();
  });

  it("voided entries are excluded from requirements query", async () => {
    // Post and void — the original entry's lines should not be counted
    // Only the reversal entry's lines will appear
    const entryId = uuidv7();
    const bankId = await getAccountId("Assets:Bank");
    const tradingId = await getAccountId("Equity:Trading");
    await backend.postJournalEntry(
      { id: entryId, date: "2024-02-01", description: "Will void", status: "confirmed", source: "", voided_by: null, created_at: "2024-02-01" },
      [
        { id: uuidv7(), journal_entry_id: entryId, account_id: bankId, currency: "EUR", amount: "50", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: tradingId, currency: "EUR", amount: "-50", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: tradingId, currency: "USD", amount: "55", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: bankId, currency: "USD", amount: "-55", lot_id: null },
      ],
    );
    await backend.voidJournalEntry(entryId);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    const eurReq = reqs.find((r) => r.currency === "EUR");
    // EUR appears due to the reversal entry (which has status='confirmed')
    // but the voided original (status='voided') is excluded
    expect(eurReq).toBeDefined();
    // The reversal date is today, not the original date
    expect(eurReq!.firstDate).not.toBe("2024-02-01");
  });

  it("hasBalance is false when net balance is zero", async () => {
    await postEntry("2024-01-15", "Buy EUR", [
      { account: "Assets:Bank", currency: "EUR", amount: "100" },
      { account: "Equity:Trading", currency: "EUR", amount: "-100" },
      { account: "Equity:Trading", currency: "USD", amount: "110" },
      { account: "Assets:Bank", currency: "USD", amount: "-110" },
    ]);
    await postEntry("2024-06-15", "Sell EUR", [
      { account: "Assets:Bank", currency: "EUR", amount: "-100" },
      { account: "Equity:Trading", currency: "EUR", amount: "100" },
      { account: "Equity:Trading", currency: "USD", amount: "-110" },
      { account: "Assets:Bank", currency: "USD", amount: "110" },
    ]);

    const reqs = await backend.getCurrencyDateRequirements("USD");
    const eurReq = reqs.find((r) => r.currency === "EUR");
    expect(eurReq).toBeDefined();
    expect(eurReq!.hasBalance).toBe(false); // net 0 in asset accounts
  });
});

describe("getExchangeRatesBatchExact", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
    await backend.createCurrency({ code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true });
    await backend.createCurrency({ code: "EUR", asset_type: "", param: "", name: "Euro", decimal_places: 2, is_base: false });
  });

  it("returns true only for exact date matches", async () => {
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-01-15", from_currency: "EUR", to_currency: "USD",
      rate: "1.10", source: "frankfurter",
    });

    const result = await backend.getExchangeRatesBatchExact(
      [
        { currency: "EUR", date: "2024-01-15" },
        { currency: "EUR", date: "2024-06-15" },
      ],
      "USD",
    );

    expect(result.get("EUR:2024-01-15")).toBe(true);
    expect(result.get("EUR:2024-06-15")).toBe(false);
  });

  it("considers inverse rates as available", async () => {
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-03-01", from_currency: "USD", to_currency: "EUR",
      rate: "0.91", source: "frankfurter",
    });

    const result = await backend.getExchangeRatesBatchExact(
      [{ currency: "EUR", date: "2024-03-01" }],
      "USD",
    );

    expect(result.get("EUR:2024-03-01")).toBe(true);
  });
});

describe("findMissingRates with exactDateMatch", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
    await backend.createCurrency({ code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true });
    await backend.createCurrency({ code: "EUR", asset_type: "", param: "", name: "Euro", decimal_places: 2, is_base: false });
  });

  it("detects gaps that on-or-before matching would miss", async () => {
    // Only have a rate for January
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-01-15", from_currency: "EUR", to_currency: "USD",
      rate: "1.10", source: "frankfurter",
    });

    // Without exactDateMatch: June would appear "available" due to on-or-before
    const withoutExact = await findMissingRates(
      backend, "USD",
      [{ currency: "EUR", date: "2024-06-15" }],
    );
    // on-or-before finds the Jan rate, so no missing
    expect(withoutExact.length).toBe(0);

    // With exactDateMatch: June should be missing
    const withExact = await findMissingRates(
      backend, "USD",
      [{ currency: "EUR", date: "2024-06-15" }],
      undefined,
      { exactDateMatch: true },
    );
    expect(withExact.length).toBe(1);
    expect(withExact[0].currency).toBe("EUR");
    expect(withExact[0].dates).toContain("2024-06-15");
  });

  it("does not flag dates that have exact rates", async () => {
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-01-15", from_currency: "EUR", to_currency: "USD",
      rate: "1.10", source: "frankfurter",
    });

    const result = await findMissingRates(
      backend, "USD",
      [{ currency: "EUR", date: "2024-01-15" }],
      undefined,
      { exactDateMatch: true },
    );
    expect(result.length).toBe(0);
  });
});
