import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import Decimal from "decimal.js-light";
import { importLedger } from "$lib/browser-ledger-file.js";
import { createTestBackend } from "./helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { LedgerImportResult } from "$lib/types/index.js";

/**
 * Ledger CLI vs dledger accounting engine comparison test.
 *
 * Imports `tmp/example.dat` (12 ledger transactions, 10 accounts,
 * single commodity USD) and compares the resulting balances/reports
 * against hardcoded reference values obtained from `ledger` CLI.
 *
 * Reference commands:
 *   ledger -f tmp/example.dat balance --flat --no-total
 *   ledger -f tmp/example.dat balance --flat --no-total --begin 2022-01-01 --end 2022-02-01
 */

let backend: SqlJsBackend;
let importResult: LedgerImportResult;
let accountsByName: Map<string, string>; // full_name → id

beforeAll(async () => {
  backend = await createTestBackend();
  const content = readFileSync(
    resolve(__dirname, "./fixtures/example.dat"),
    "utf-8",
  );
  importResult = await importLedger(backend, content, "ledger");

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

// ---- Reference data from ledger CLI ----

// ledger -f tmp/example.dat balance --flat --no-total
const ALL_TIME_BALANCES: [string, string, string][] = [
  // [accountName, amount, currency]
  ["Assets:Bank:Checking", "3733", "USD"],
  ["Assets:Cash:Wallet", "100", "USD"],
  ["Assets:Crypto:BTC", "300", "USD"],
  ["Assets:Crypto:ETH", "200", "USD"],
  ["Equity:OpeningBalances", "-1000", "USD"],
  ["Expenses:Books", "20", "USD"],
  ["Expenses:Food:Groceries", "667", "USD"],
  ["Expenses:Food:TakeOut", "40.92", "USD"],
  ["Income:Salary", "-4000", "USD"],
  ["Liabilities:MasterCard", "-60.92", "USD"],
];

// Income statement Jan 2022: incomeStatement("2022-01-01", "2022-02-01")
const INCOME_STATEMENT_JAN_2022: [string, string, string][] = [
  ["Income:Salary", "-2000", "USD"],
  ["Expenses:Books", "20", "USD"],
  ["Expenses:Food:Groceries", "445", "USD"],
  ["Expenses:Food:TakeOut", "40.92", "USD"],
];

describe("ledger comparison", () => {
  describe("import validation", () => {
    it("imports 12 transactions", () => {
      expect(importResult.transactions_imported).toBe(12);
    });

    it("creates all 10 referenced accounts", () => {
      const expected = ALL_TIME_BALANCES.map(([name]) => name);
      for (const name of expected) {
        expect(
          accountsByName.has(name),
          `Account ${name} should exist`,
        ).toBe(true);
      }
    });

    it("has no unexpected warnings", () => {
      const unexpectedWarnings = importResult.warnings.filter(
        (w) =>
          !w.includes("balance assertion") &&
          !w.includes("commodity directive"),
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

  describe("income statement Jan 2022", () => {
    let periodBalances: Map<string, Map<string, string>>;

    beforeAll(async () => {
      const is = await backend.incomeStatement("2022-01-01", "2022-02-01");
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

    for (const [account, expectedAmount, currency] of INCOME_STATEMENT_JAN_2022) {
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
    it("total debits = total credits for USD", async () => {
      const tb = await backend.trialBalance("9999-12-31");
      const debit = tb.total_debits.find((d) => d.currency === "USD");
      const credit = tb.total_credits.find((c) => c.currency === "USD");
      expect(debit, "No debit total for USD").toBeDefined();
      expect(credit, "No credit total for USD").toBeDefined();
      expectDecimalEqual(
        credit!.amount,
        debit!.amount,
        "Trial balance USD",
      );
    });
  });
});
