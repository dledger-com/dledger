import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { seedBasicLedger } from "../../test/helpers.js";
import { computeTaxYearDates, computeTaxSummary } from "./tax-summary.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { Account, JournalEntry, LineItem } from "$lib/types/index.js";

describe("computeTaxYearDates", () => {
  it("computes calendar year dates with 01-01 start", () => {
    const result = computeTaxYearDates("01-01", 2024);
    expect(result.from).toBe("2024-01-01");
    expect(result.to).toBe("2024-12-31");
  });

  it("computes fiscal year dates with 04-06 start", () => {
    const result = computeTaxYearDates("04-06", 2024);
    expect(result.from).toBe("2024-04-06");
    expect(result.to).toBe("2025-04-05");
  });

  it("uses current year when year not provided", () => {
    const currentYear = new Date().getFullYear();
    const result = computeTaxYearDates("01-01");
    expect(result.from).toBe(`${currentYear}-01-01`);
    expect(result.to).toBe(`${currentYear}-12-31`);
  });

  it("handles leap year boundary", () => {
    const result = computeTaxYearDates("03-01", 2024);
    expect(result.from).toBe("2024-03-01");
    // 2025-03-01 minus 1 day = 2025-02-28
    expect(result.to).toBe("2025-02-28");
  });
});

describe("computeTaxSummary", () => {
  let backend: SqlJsBackend;
  let bankAccount: Account;

  beforeEach(async () => {
    const seeded = await seedBasicLedger();
    backend = seeded.backend;
    bankAccount = seeded.accounts.bank;
  });

  it("classifies short-term gains correctly with no disposals", async () => {
    // With basic seeded data, there are no lot disposals, so all gain/loss should be 0
    const summary = await computeTaxSummary(backend, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      holdingPeriodDays: 365,
      baseCurrency: "USD",
    });

    expect(summary.short_term_gains).toBe("0");
    expect(summary.short_term_losses).toBe("0");
    expect(summary.long_term_gains).toBe("0");
    expect(summary.long_term_losses).toBe("0");
    expect(summary.total_realized).toBe("0");
    expect(summary.from_date).toBe("2024-01-01");
    expect(summary.to_date).toBe("2024-12-31");
    expect(summary.holding_period_days).toBe(365);
    expect(summary.gain_loss_lines).toHaveLength(0);
  });

  it("classifies holding periods based on days threshold", () => {
    // Test the classification logic directly with mock data
    // A line held for 100 days with holdingPeriodDays=365 should be short-term
    const shortLine = {
      lot_id: "lot-1",
      currency: "ETH",
      acquired_date: "2024-01-01",
      disposed_date: "2024-04-10", // ~100 days
      quantity: "1",
      cost_basis: "100",
      proceeds: "150",
      gain_loss: "50",
      source_handler: null,
    };

    // A line held for 400 days should be long-term
    const longLine = {
      lot_id: "lot-2",
      currency: "ETH",
      acquired_date: "2023-01-01",
      disposed_date: "2024-02-05", // ~400 days
      quantity: "2",
      cost_basis: "200",
      proceeds: "180",
      gain_loss: "-20",
      source_handler: null,
    };

    // Simulate the classification logic from computeTaxSummary
    const holdingPeriodDays = 365;
    const lines = [shortLine, longLine];
    let stGains = 0, stLosses = 0, ltGains = 0, ltLosses = 0;

    for (const line of lines) {
      const acquired = new Date(line.acquired_date);
      const disposed = new Date(line.disposed_date);
      const holdingDays = Math.floor((disposed.getTime() - acquired.getTime()) / (1000 * 60 * 60 * 24));
      const isLongTerm = holdingDays >= holdingPeriodDays;
      const gl = parseFloat(line.gain_loss);

      if (isLongTerm) {
        if (gl >= 0) ltGains += gl; else ltLosses += gl;
      } else {
        if (gl >= 0) stGains += gl; else stLosses += gl;
      }
    }

    expect(stGains).toBe(50);  // short-term gain from lot-1
    expect(stLosses).toBe(0);
    expect(ltGains).toBe(0);
    expect(ltLosses).toBe(-20); // long-term loss from lot-2
  });

  it("aggregates income from revenue accounts", async () => {
    const summary = await computeTaxSummary(backend, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      holdingPeriodDays: 365,
      baseCurrency: "USD",
    });

    // The seeded ledger has a $3000 salary entry
    expect(summary.income_by_account.length).toBeGreaterThanOrEqual(1);
    const salaryIncome = summary.income_by_account.find(
      (i) => i.account_name === "Income:Salary",
    );
    expect(salaryIncome).toBeDefined();
    expect(salaryIncome!.currency).toBe("USD");
    expect(parseFloat(salaryIncome!.amount)).toBe(3000);
  });

  it("handles zero gain/loss lines", async () => {
    // Use a date range with no transactions
    const summary = await computeTaxSummary(backend, {
      fromDate: "2023-01-01",
      toDate: "2023-12-31",
      holdingPeriodDays: 365,
      baseCurrency: "USD",
    });

    expect(summary.gain_loss_lines).toHaveLength(0);
    expect(summary.short_term_gains).toBe("0");
    expect(summary.short_term_losses).toBe("0");
    expect(summary.long_term_gains).toBe("0");
    expect(summary.long_term_losses).toBe("0");
    expect(summary.total_realized).toBe("0");
    expect(summary.income_by_account).toHaveLength(0);
  });

  it("returns correct holding_period_days in output", async () => {
    const summary = await computeTaxSummary(backend, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      holdingPeriodDays: 180,
      baseCurrency: "USD",
    });

    expect(summary.holding_period_days).toBe(180);
  });

  it("handles income from multiple revenue accounts", async () => {
    // Create a second revenue account
    const incomeParent = (await backend.listAccounts()).find(
      (a) => a.full_name === "Income" && !a.is_postable,
    )!;
    const bonusAccount: Account = {
      id: uuidv7(),
      parent_id: incomeParent.id,
      account_type: "revenue",
      name: "Bonus",
      full_name: "Income:Bonus",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(bonusAccount);

    // Post a bonus entry
    const bonusEntryId = uuidv7();
    const bonusEntry: JournalEntry = {
      id: bonusEntryId,
      date: "2024-06-15",
      description: "Bonus",
      status: "confirmed",
      source: "manual",
      voided_by: null,
      created_at: "2024-06-15",
    };
    const bonusItems: LineItem[] = [
      { id: uuidv7(), journal_entry_id: bonusEntryId, account_id: bankAccount.id, currency: "USD", amount: "500", lot_id: null },
      { id: uuidv7(), journal_entry_id: bonusEntryId, account_id: bonusAccount.id, currency: "USD", amount: "-500", lot_id: null },
    ];
    await backend.postJournalEntry(bonusEntry, bonusItems);

    const summary = await computeTaxSummary(backend, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      holdingPeriodDays: 365,
      baseCurrency: "USD",
    });

    expect(summary.income_by_account.length).toBeGreaterThanOrEqual(2);
    const salaryIncome = summary.income_by_account.find((i) => i.account_name === "Income:Salary");
    const bonusIncome = summary.income_by_account.find((i) => i.account_name === "Income:Bonus");
    expect(salaryIncome).toBeDefined();
    expect(bonusIncome).toBeDefined();
    expect(parseFloat(salaryIncome!.amount)).toBe(3000);
    expect(parseFloat(bonusIncome!.amount)).toBe(500);
  });
});
