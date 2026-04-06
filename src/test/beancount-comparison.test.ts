import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import Decimal from "decimal.js-light";
import { importLedger } from "$lib/browser-ledger-file.js";
import { createTestBackend } from "./helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { LedgerImportResult } from "$lib/types/index.js";

/**
 * Beancount vs dledger accounting engine comparison test.
 *
 * Imports `tmp/example.beancount` (788 beancount transactions, 63 accounts,
 * 10 commodities) and compares the resulting balances/reports against hardcoded
 * reference values obtained from `bean-query` CLI.
 *
 * One transaction (line 2306: zero-amount dividend) is skipped during import,
 * yielding 787 imported transactions.
 */

let backend: SqlJsBackend;
let importResult: LedgerImportResult;
let accountsByName: Map<string, string>; // full_name → id

beforeAll(async () => {
  backend = await createTestBackend();
  const content = readFileSync(
    resolve(__dirname, "./fixtures/example.beancount"),
    "utf-8",
  );
  importResult = await importLedger(backend, content, "beancount");

  // Build account name → id map
  accountsByName = new Map();
  for (const acc of await backend.listAccounts()) {
    accountsByName.set(acc.full_name, acc.id);
  }
});

// ---- Helpers ----

/** Compare a Decimal amount, handling trailing zeros. */
function expectDecimalEqual(actual: string, expected: string, label: string) {
  const a = new Decimal(actual);
  const e = new Decimal(expected);
  expect(a.eq(e), `${label}: expected ${expected}, got ${actual}`).toBe(true);
}

/** Get a single-currency balance for an account from the backend. */
async function getBalance(
  accountName: string,
  currency: string,
): Promise<string> {
  const id = accountsByName.get(accountName);
  if (!id) throw new Error(`Account not found: ${accountName}`);
  const balances = await backend.getAccountBalance(id);
  const bal = balances.find((b) => b.currency === currency);
  return bal?.amount ?? "0";
}

// ---- Reference data from bean-query ----

const ALL_TIME_BALANCES: [string, string, string][] = [
  // [accountName, amount, currency]
  // Assets
  ["Assets:US:BofA:Checking", "382.59", "USD"],
  ["Assets:US:ETrade:Cash", "9958.74", "USD"],
  ["Assets:US:ETrade:GLD", "36", "GLD"],
  ["Assets:US:ETrade:ITOT", "13", "ITOT"],
  ["Assets:US:ETrade:VEA", "10", "VEA"],
  ["Assets:US:ETrade:VHT", "83", "VHT"],
  ["Assets:US:Federal:PreTax401k", "13700.00", "IRAUSD"],
  ["Assets:US:Hooli:Vacation", "128", "VACHR"],
  ["Assets:US:Vanguard:Cash", "-0.07", "USD"],
  ["Assets:US:Vanguard:RGAGX", "426.321", "RGAGX"],
  ["Assets:US:Vanguard:VBMPX", "188.347", "VBMPX"],
  // Liabilities
  ["Liabilities:AccountsPayable", "0.00", "USD"],
  ["Liabilities:US:Chase:Slate", "-1508.62", "USD"],
  // Income
  ["Income:US:ETrade:GLD:Dividend", "-60.11", "USD"],
  ["Income:US:ETrade:PnL", "-104.69", "USD"],
  ["Income:US:ETrade:VEA:Dividend", "-154.83", "USD"],
  ["Income:US:ETrade:VHT:Dividend", "-120.22", "USD"],
  ["Income:US:Federal:PreTax401k", "-55500", "IRAUSD"],
  ["Income:US:Hooli:GroupTermLife", "-1361.92", "USD"],
  ["Income:US:Hooli:Match401k", "-20900.00", "USD"],
  ["Income:US:Hooli:Salary", "-258461.28", "USD"],
  ["Income:US:Hooli:Vacation", "-280", "VACHR"],
  // Expenses
  ["Expenses:Financial:Commissions", "196.90", "USD"],
  ["Expenses:Financial:Fees", "104.00", "USD"],
  ["Expenses:Food:Alcohol", "14.54", "USD"],
  ["Expenses:Food:Coffee", "31.11", "USD"],
  ["Expenses:Food:Groceries", "4532.65", "USD"],
  ["Expenses:Food:Restaurant", "8524.43", "USD"],
  ["Expenses:Health:Dental:Insurance", "162.40", "USD"],
  ["Expenses:Health:Life:GroupTermLife", "1361.92", "USD"],
  ["Expenses:Health:Medical:Insurance", "1533.28", "USD"],
  ["Expenses:Health:Vision:Insurance", "2368.80", "USD"],
  ["Expenses:Home:Electricity", "1625.00", "USD"],
  ["Expenses:Home:Internet", "2000.12", "USD"],
  ["Expenses:Home:Phone", "1566.09", "USD"],
  ["Expenses:Home:Rent", "60000.00", "USD"],
  ["Expenses:Taxes:Y2024:US:CityNYC", "4547.92", "USD"],
  ["Expenses:Taxes:Y2024:US:Federal", "28172.12", "USD"],
  ["Expenses:Taxes:Y2024:US:Federal:PreTax401k", "18500.00", "IRAUSD"],
  ["Expenses:Taxes:Y2024:US:Medicare", "2772.12", "USD"],
  ["Expenses:Taxes:Y2024:US:SDI", "29.12", "USD"],
  ["Expenses:Taxes:Y2024:US:SocSec", "7000.04", "USD"],
  ["Expenses:Taxes:Y2024:US:State", "9789.35", "USD"],
  ["Expenses:Taxes:Y2025:US:CityNYC", "4547.92", "USD"],
  ["Expenses:Taxes:Y2025:US:Federal", "27635.92", "USD"],
  ["Expenses:Taxes:Y2025:US:Federal:PreTax401k", "18500.00", "IRAUSD"],
  ["Expenses:Taxes:Y2025:US:Medicare", "2772.12", "USD"],
  ["Expenses:Taxes:Y2025:US:SDI", "29.12", "USD"],
  ["Expenses:Taxes:Y2025:US:SocSec", "7000.04", "USD"],
  ["Expenses:Taxes:Y2025:US:State", "9492.08", "USD"],
  ["Expenses:Taxes:Y2026:US:CityNYC", "699.68", "USD"],
  ["Expenses:Taxes:Y2026:US:Federal", "4251.68", "USD"],
  ["Expenses:Taxes:Y2026:US:Federal:PreTax401k", "4800.00", "IRAUSD"],
  ["Expenses:Taxes:Y2026:US:Medicare", "426.48", "USD"],
  ["Expenses:Taxes:Y2026:US:SDI", "4.48", "USD"],
  ["Expenses:Taxes:Y2026:US:SocSec", "1126.16", "USD"],
  ["Expenses:Taxes:Y2026:US:State", "1460.32", "USD"],
  ["Expenses:Transport:Tram", "3120.00", "USD"],
  ["Expenses:Vacation", "152", "VACHR"],
  // Equity
  ["Equity:Opening-Balances", "-3051.78", "USD"],
];

// Income statement 2024: incomeStatement("2024-01-01", "2025-01-01")
// = all transactions with date in [2024-01-01, 2024-12-31]
const INCOME_STATEMENT_2024: [string, string, string][] = [
  ["Income:US:ETrade:PnL", "-70.68", "USD"],
  ["Income:US:ETrade:VEA:Dividend", "-48.31", "USD"],
  ["Income:US:Federal:PreTax401k", "-18500", "IRAUSD"],
  ["Income:US:Hooli:GroupTermLife", "-632.32", "USD"],
  ["Income:US:Hooli:Match401k", "-9250", "USD"],
  ["Income:US:Hooli:Salary", "-119999.88", "USD"],
  ["Income:US:Hooli:Vacation", "-130", "VACHR"],
  ["Expenses:Financial:Commissions", "62.65", "USD"],
  ["Expenses:Financial:Fees", "48", "USD"],
  ["Expenses:Food:Alcohol", "14.54", "USD"],
  ["Expenses:Food:Coffee", "19.68", "USD"],
  ["Expenses:Food:Groceries", "2296.17", "USD"],
  ["Expenses:Food:Restaurant", "3601.85", "USD"],
  ["Expenses:Health:Dental:Insurance", "75.4", "USD"],
  ["Expenses:Health:Life:GroupTermLife", "632.32", "USD"],
  ["Expenses:Health:Medical:Insurance", "711.88", "USD"],
  ["Expenses:Health:Vision:Insurance", "1099.8", "USD"],
  ["Expenses:Home:Electricity", "780", "USD"],
  ["Expenses:Home:Internet", "959.51", "USD"],
  ["Expenses:Home:Phone", "760.68", "USD"],
  ["Expenses:Home:Rent", "28800", "USD"],
  ["Expenses:Taxes:Y2024:US:CityNYC", "4547.92", "USD"],
  ["Expenses:Taxes:Y2024:US:Federal", "27635.92", "USD"],
  ["Expenses:Taxes:Y2024:US:Federal:PreTax401k", "18500", "IRAUSD"],
  ["Expenses:Taxes:Y2024:US:Medicare", "2772.12", "USD"],
  ["Expenses:Taxes:Y2024:US:SDI", "29.12", "USD"],
  ["Expenses:Taxes:Y2024:US:SocSec", "7000.04", "USD"],
  ["Expenses:Taxes:Y2024:US:State", "9492.08", "USD"],
  ["Expenses:Transport:Tram", "1440", "USD"],
  ["Expenses:Vacation", "80", "VACHR"],
];

// Income statement 2025: incomeStatement("2025-01-01", "2026-01-01")
// = all transactions with date in [2025-01-01, 2025-12-31]
const INCOME_STATEMENT_2025: [string, string, string][] = [
  ["Income:US:ETrade:GLD:Dividend", "-60.11", "USD"],
  ["Income:US:ETrade:PnL", "-195.83", "USD"],
  ["Income:US:ETrade:VEA:Dividend", "-106.52", "USD"],
  ["Income:US:ETrade:VHT:Dividend", "-120.22", "USD"],
  ["Income:US:Federal:PreTax401k", "-18500", "IRAUSD"],
  ["Income:US:Hooli:GroupTermLife", "-632.32", "USD"],
  ["Income:US:Hooli:Match401k", "-9250", "USD"],
  ["Income:US:Hooli:Salary", "-119999.88", "USD"],
  ["Income:US:Hooli:Vacation", "-130", "VACHR"],
  ["Expenses:Financial:Commissions", "125.3", "USD"],
  ["Expenses:Financial:Fees", "48", "USD"],
  ["Expenses:Food:Coffee", "11.43", "USD"],
  ["Expenses:Food:Groceries", "2009.9", "USD"],
  ["Expenses:Food:Restaurant", "4358.36", "USD"],
  ["Expenses:Health:Dental:Insurance", "75.4", "USD"],
  ["Expenses:Health:Life:GroupTermLife", "632.32", "USD"],
  ["Expenses:Health:Medical:Insurance", "711.88", "USD"],
  ["Expenses:Health:Vision:Insurance", "1099.8", "USD"],
  ["Expenses:Home:Electricity", "780", "USD"],
  ["Expenses:Home:Internet", "960.55", "USD"],
  ["Expenses:Home:Phone", "734.59", "USD"],
  ["Expenses:Home:Rent", "28800", "USD"],
  ["Expenses:Taxes:Y2024:US:Federal", "536.2", "USD"],
  ["Expenses:Taxes:Y2024:US:State", "297.27", "USD"],
  ["Expenses:Taxes:Y2025:US:CityNYC", "4547.92", "USD"],
  ["Expenses:Taxes:Y2025:US:Federal", "27635.92", "USD"],
  ["Expenses:Taxes:Y2025:US:Federal:PreTax401k", "18500", "IRAUSD"],
  ["Expenses:Taxes:Y2025:US:Medicare", "2772.12", "USD"],
  ["Expenses:Taxes:Y2025:US:SDI", "29.12", "USD"],
  ["Expenses:Taxes:Y2025:US:SocSec", "7000.04", "USD"],
  ["Expenses:Taxes:Y2025:US:State", "9492.08", "USD"],
  ["Expenses:Transport:Tram", "1440", "USD"],
  ["Expenses:Vacation", "72", "VACHR"],
];

describe("beancount comparison", () => {
  describe("import validation", () => {
    it("imports 787 transactions (1 zero-amount dividend skipped)", () => {
      expect(importResult.transactions_imported).toBe(787);
    });

    it("has no parse errors (only expected warnings)", () => {
      const unexpectedWarnings = importResult.warnings.filter(
        (w) =>
          !w.includes("balance assertion") &&
          !w.includes("pad directive skipped") &&
          !w.includes("skipped transaction with only zero-amount postings"),
      );
      expect(unexpectedWarnings).toEqual([]);
    });
  });

  describe("all-time account balances", () => {
    for (const [account, expectedAmount, currency] of ALL_TIME_BALANCES) {
      it(`${account} = ${expectedAmount} ${currency}`, async () => {
        const actual = await getBalance(account, currency);
        expectDecimalEqual(actual, expectedAmount, account);
      });
    }
  });

  describe("income statement 2024", () => {
    let periodBalances: Map<string, Map<string, string>>;

    beforeAll(async () => {
      const is = await backend.incomeStatement("2024-01-01", "2025-01-01");
      periodBalances = new Map();

      for (const line of [...is.revenue.lines, ...is.expenses.lines]) {
        const acc = await backend.getAccount(line.account_id);
        if (!acc) continue;
        const balMap = new Map<string, string>();
        for (const bal of line.balances) {
          balMap.set(bal.currency, bal.amount);
        }
        periodBalances.set(acc.full_name, balMap);
      }
    });

    for (const [account, expectedAmount, currency] of INCOME_STATEMENT_2024) {
      it(`${account} = ${expectedAmount} ${currency}`, () => {
        const balMap = periodBalances.get(account);
        expect(
          balMap,
          `Account ${account} not found in income statement`,
        ).toBeDefined();
        const actual = balMap!.get(currency) ?? "0";
        expectDecimalEqual(actual, expectedAmount, account);
      });
    }
  });

  describe("income statement 2025", () => {
    let periodBalances: Map<string, Map<string, string>>;

    beforeAll(async () => {
      const is = await backend.incomeStatement("2025-01-01", "2026-01-01");
      periodBalances = new Map();

      for (const line of [...is.revenue.lines, ...is.expenses.lines]) {
        const acc = await backend.getAccount(line.account_id);
        if (!acc) continue;
        const balMap = new Map<string, string>();
        for (const bal of line.balances) {
          balMap.set(bal.currency, bal.amount);
        }
        periodBalances.set(acc.full_name, balMap);
      }
    });

    for (const [account, expectedAmount, currency] of INCOME_STATEMENT_2025) {
      it(`${account} = ${expectedAmount} ${currency}`, () => {
        const balMap = periodBalances.get(account);
        expect(
          balMap,
          `Account ${account} not found in income statement`,
        ).toBeDefined();
        const actual = balMap!.get(currency) ?? "0";
        expectDecimalEqual(actual, expectedAmount, account);
      });
    }
  });

  describe("trial balance consistency", () => {
    it("total debits = total credits per currency", async () => {
      const tb = await backend.trialBalance("9999-12-31");
      for (const debit of tb.total_debits) {
        const credit = tb.total_credits.find(
          (c) => c.currency === debit.currency,
        );
        expect(
          credit,
          `No credit total for ${debit.currency}`,
        ).toBeDefined();
        expectDecimalEqual(
          credit!.amount,
          debit.amount,
          `Trial balance ${debit.currency}`,
        );
      }
    });
  });

  describe("trading account consistency", () => {
    it("each Equity:Trading:X commodity balance offsets held positions", async () => {
      const accounts = await backend.listAccounts();
      const tradingAccounts = accounts.filter((a) =>
        a.full_name.startsWith("Equity:Trading:"),
      );

      for (const tradingAcc of tradingAccounts) {
        // Extract commodity name: Equity:Trading:GLD → GLD
        const commodity = tradingAcc.full_name.split(":")[2];
        const tradingBals = await backend.getAccountBalance(tradingAcc.id);
        const tradingCommodityBal =
          tradingBals.find((b) => b.currency === commodity)?.amount ?? "0";

        // Sum all non-trading account balances in this commodity
        let assetSum = new Decimal(0);
        for (const acc of accounts) {
          if (acc.full_name.startsWith("Equity:Trading:")) continue;
          if (!acc.is_postable) continue;
          const bals = await backend.getAccountBalance(acc.id);
          const bal = bals.find((b) => b.currency === commodity);
          if (bal) assetSum = assetSum.plus(new Decimal(bal.amount));
        }

        // Trading commodity balance should be the negative of all other held positions
        const sum = assetSum.plus(new Decimal(tradingCommodityBal));
        expect(
          sum.isZero(),
          `Trading:${commodity} in ${commodity}: trading=${tradingCommodityBal}, others=${assetSum}, sum=${sum}`,
        ).toBe(true);
      }
    });
  });
});
