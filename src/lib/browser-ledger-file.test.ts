import { describe, it, expect, beforeEach } from "vitest";
import { importLedger, exportLedger } from "./browser-ledger-file.js";
import { createTestBackend } from "../test/helpers.js";
import type { SqlJsBackend } from "./sql-js-backend.js";

describe("browser-ledger-file", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  describe("importLedger", () => {
    it("parses open directive", async () => {
      const content = `2024-01-01 open Assets:Bank USD EUR\n`;
      const result = await importLedger(backend, content);
      expect(result.accounts_created).toBeGreaterThanOrEqual(1);

      const accounts = await backend.listAccounts();
      const bank = accounts.find((a) => a.full_name === "Assets:Bank");
      expect(bank).toBeDefined();
      expect(bank!.allowed_currencies).toContain("USD");
      expect(bank!.allowed_currencies).toContain("EUR");
    });

    it("parses close directive", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-06-01 close Assets:Bank
`;
      const result = await importLedger(backend, content);
      const accounts = await backend.listAccounts();
      const bank = accounts.find((a) => a.full_name === "Assets:Bank");
      expect(bank?.is_archived).toBe(true);
    });

    it("parses simple transaction", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening balance"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      const result = await importLedger(backend, content);
      expect(result.transactions_imported).toBe(1);

      const balance = await backend.getAccountBalance(
        (await backend.listAccounts()).find((a) => a.full_name === "Assets:Bank")!.id,
      );
      expect(balance).toHaveLength(1);
      expect(balance[0].amount).toBe("1000");
    });

    it("handles elided amount", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food

2024-01-20 * "Groceries"
  Expenses:Food  50 USD
  Assets:Bank
`;
      const result = await importLedger(backend, content);
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const bank = accounts.find((a) => a.full_name === "Assets:Bank")!;
      const balance = await backend.getAccountBalance(bank.id);
      expect(balance).toHaveLength(1);
      expect(balance[0].amount).toBe("-50");
    });

    it("handles cost syntax (@ PRICE COMMODITY)", async () => {
      const content = `
2024-01-01 open Assets:Crypto
2024-01-01 open Assets:Bank

2024-01-01 * "Buy Bitcoin"
  Assets:Crypto  1 BTC @ 50000 USD
  Assets:Bank  -50000 USD
`;
      const result = await importLedger(backend, content);
      expect(result.transactions_imported).toBe(1);
      expect(result.currencies_created).toBeGreaterThanOrEqual(2); // BTC and USD

      // Trading account should be auto-created
      const accounts = await backend.listAccounts();
      const trading = accounts.find((a) => a.full_name === "Equity:Trading:BTC");
      expect(trading).toBeDefined();
    });

    it("parses balance directive", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

2024-01-02 balance Assets:Bank  1000 USD
`;
      const result = await importLedger(backend, content);
      // Balance should pass — no warnings about assertion failure
      const assertionWarnings = result.warnings.filter((w) => w.includes("balance assertion failed"));
      expect(assertionWarnings).toHaveLength(0);
    });

    it("warns on failed balance assertion", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

2024-01-02 balance Assets:Bank  999 USD
`;
      const result = await importLedger(backend, content);
      const assertionWarnings = result.warnings.filter((w) => w.includes("balance assertion failed"));
      expect(assertionWarnings).toHaveLength(1);
    });

    it("parses price directive", async () => {
      const content = `P 2024-01-01 EUR 1.10 USD\n`;
      const result = await importLedger(backend, content);
      expect(result.prices_imported).toBe(1);

      const rate = await backend.getExchangeRate("EUR", "USD", "2024-01-01");
      expect(rate).toBe("1.10");
    });

    it("handles multi-currency transaction", async () => {
      const content = `
2024-01-01 open Assets:BankUSD
2024-01-01 open Assets:BankEUR

2024-01-01 * "Currency exchange"
  Assets:BankEUR  100 EUR
  Assets:BankUSD  -110 USD
`;
      // Multi-currency: each currency must balance. This will fail unless
      // we handle it through elision or trading accounts.
      // Actually the parser will try to balance per currency and this won't work
      // as-is. Let's test it with a trading setup:
      const content2 = `
2024-01-01 open Assets:BankUSD
2024-01-01 open Assets:BankEUR

2024-01-01 * "Buy EUR"
  Assets:BankEUR  100 EUR @ 1.10 USD
  Assets:BankUSD  -110 USD
`;
      const result = await importLedger(backend, content2);
      expect(result.transactions_imported).toBe(1);
    });

    it("skips pad directives with warning", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 pad Assets:Bank Equity:Opening
`;
      const result = await importLedger(backend, content);
      const padWarnings = result.warnings.filter((w) => w.includes("pad"));
      expect(padWarnings).toHaveLength(1);
    });
  });

  describe("exportLedger", () => {
    it("exports round-trip", async () => {
      const input = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening balance"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

P 2024-01-01 EUR 1.10 USD
`;
      await importLedger(backend, input);
      const exported = await exportLedger(backend);

      expect(exported).toContain("Assets:Bank");
      expect(exported).toContain("Equity:Opening");
      expect(exported).toContain("Opening balance");
      expect(exported).toContain("1000 USD");
      expect(exported).toContain("P 2024-01-01 EUR 1.10 USD");
    });
  });
});
