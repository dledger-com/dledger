import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import Decimal from "decimal.js-light";
import { importLedger } from "$lib/browser-ledger-file.js";
import { createTestBackend } from "./helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { LedgerImportResult } from "$lib/types/index.js";

/**
 * hledger vs dledger accounting engine comparison test.
 *
 * Imports `tmp/example.journal` (5 hledger transactions, 8 accounts,
 * single commodity $ → USD) and compares the resulting balances/reports
 * against hardcoded reference values obtained from `hledger` CLI.
 *
 * Reference commands:
 *   hledger -f tmp/example.journal balance --flat --no-total
 *   hledger -f tmp/example.journal incomestatement --flat --no-total -b 2008-01-01 -e 2009-01-01
 *   hledger -f tmp/example.journal incomestatement --flat --no-total -b 2008-01-01 -e 2008-07-01
 */

let backend: SqlJsBackend;
let importResult: LedgerImportResult;
let accountsByName: Map<string, string>; // full_name → id

beforeAll(async () => {
  backend = await createTestBackend();
  const content = readFileSync(
    resolve(__dirname, "../../tmp/example.journal"),
    "utf-8",
  );
  importResult = await importLedger(backend, content, "hledger");

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

// ---- Reference data from hledger CLI ----

// hledger -f tmp/example.journal balance --flat --no-total
const ALL_TIME_BALANCES: [string, string, string][] = [
  // [accountName, amount, currency]
  ["assets:bank:saving", "1", "USD"],
  ["assets:cash", "-2", "USD"],
  ["expenses:food", "1", "USD"],
  ["expenses:supplies", "1", "USD"],
  ["income:gifts", "-1", "USD"],
  ["income:salary", "-1", "USD"],
  ["liabilities:debts", "1", "USD"],
];

// hledger -f tmp/example.journal incomestatement --flat --no-total -b 2008-01-01 -e 2009-01-01
const INCOME_STATEMENT_2008: [string, string, string][] = [
  ["income:gifts", "-1", "USD"],
  ["income:salary", "-1", "USD"],
  ["expenses:food", "1", "USD"],
  ["expenses:supplies", "1", "USD"],
];

// hledger -f tmp/example.journal incomestatement --flat --no-total -b 2008-01-01 -e 2008-07-01
// Same values — all income/expense transactions occur Jan–Jun; Dec transaction is liabilities↔assets
const INCOME_STATEMENT_H1_2008: [string, string, string][] = [
  ["income:gifts", "-1", "USD"],
  ["income:salary", "-1", "USD"],
  ["expenses:food", "1", "USD"],
  ["expenses:supplies", "1", "USD"],
];

describe("hledger comparison", () => {
  describe("import validation", () => {
    it("imports 5 transactions", () => {
      expect(importResult.transactions_imported).toBe(5);
    });

    it("creates all 8 leaf accounts (13 total with parents)", () => {
      const leafAccounts = [
        "assets:bank:checking", "assets:bank:saving", "assets:cash",
        "expenses:food", "expenses:supplies",
        "income:gifts", "income:salary",
        "liabilities:debts",
      ];
      for (const name of leafAccounts) {
        expect(accountsByName.has(name), `Account ${name} should exist`).toBe(true);
      }
      expect(accountsByName.size).toBe(13); // 8 leaf + 5 parent (assets, assets:bank, expenses, income, liabilities)
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

  describe("income statement 2008", () => {
    let periodBalances: Map<string, Map<string, string>>;

    beforeAll(async () => {
      const is = await backend.incomeStatement("2008-01-01", "2009-01-01");
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

    for (const [account, expectedAmount, currency] of INCOME_STATEMENT_2008) {
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

  describe("income statement H1 2008", () => {
    let periodBalances: Map<string, Map<string, string>>;

    beforeAll(async () => {
      const is = await backend.incomeStatement("2008-01-01", "2008-07-01");
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

    for (const [account, expectedAmount, currency] of INCOME_STATEMENT_H1_2008) {
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
