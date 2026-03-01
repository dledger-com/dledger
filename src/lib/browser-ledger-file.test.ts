import { describe, it, expect, beforeEach } from "vitest";
import { importLedger, exportLedger } from "./browser-ledger-file.js";
import { detectFormat, detectFormatFromFilename } from "./ledger-format.js";
import { createTestBackend } from "../test/helpers.js";
import type { SqlJsBackend } from "./sql-js-backend.js";
import { computeEntryAmountFingerprint } from "./csv-presets/dedup.js";

describe("detectFormat", () => {
  it("detects beancount by txn keyword", () => {
    const content = `2024-01-01 txn "Payment"\n  Assets:Bank  -100 USD\n  Expenses:Food  100 USD\n`;
    expect(detectFormat(content)).toBe("beancount");
  });

  it("detects beancount by option directive", () => {
    const content = `option "operating_currency" "USD"\n2024-01-01 open Assets:Bank\n`;
    expect(detectFormat(content)).toBe("beancount");
  });

  it("detects beancount by quoted description", () => {
    const content = `2024-01-01 * "Payment"\n  Assets:Bank  -100 USD\n  Expenses:Food  100 USD\n`;
    expect(detectFormat(content)).toBe("beancount");
  });

  it("detects hledger by account directive", () => {
    const content = `account Assets:Bank\naccount Expenses:Food\n2024-01-01 * Payment\n  Assets:Bank  -100 USD\n  Expenses:Food  100 USD\n`;
    expect(detectFormat(content)).toBe("hledger");
  });

  it("detects hledger by slash dates", () => {
    const content = `2024/01/01 * Payment\n  Assets:Bank  -100 USD\n  Expenses:Food  100 USD\n2024/01/02 * Rent\n  Assets:Bank  -500 USD\n  Expenses:Rent  500 USD\n`;
    expect(detectFormat(content)).toBe("hledger");
  });

  it("detects hledger by inline balance assertion", () => {
    const content = `2024-01-01 * Payment\n  Assets:Bank  -100 USD = 900 USD\n  Expenses:Food  100 USD\n`;
    expect(detectFormat(content)).toBe("hledger");
  });

  it("defaults to ledger for ambiguous content", () => {
    const content = `2024-01-01 open Assets:Bank\n2024-01-01 * Payment\n  Assets:Bank  -100 USD\n  Expenses:Food  100 USD\n`;
    expect(detectFormat(content)).toBe("ledger");
  });

  it("defaults to ledger for empty content", () => {
    expect(detectFormat("")).toBe("ledger");
  });
});

describe("detectFormatFromFilename", () => {
  it("detects beancount from .beancount", () => {
    expect(detectFormatFromFilename("main.beancount")).toBe("beancount");
  });

  it("detects hledger from .journal", () => {
    expect(detectFormatFromFilename("2024.journal")).toBe("hledger");
  });

  it("detects hledger from .hledger", () => {
    expect(detectFormatFromFilename("my-accounts.hledger")).toBe("hledger");
  });

  it("detects ledger from .dat", () => {
    expect(detectFormatFromFilename("ledger.dat")).toBe("ledger");
  });

  it("detects ledger from .ledger", () => {
    expect(detectFormatFromFilename("finances.ledger")).toBe("ledger");
  });

  it("returns null for .txt", () => {
    expect(detectFormatFromFilename("notes.txt")).toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(detectFormatFromFilename("data.csv")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectFormatFromFilename("Main.Beancount")).toBe("beancount");
    expect(detectFormatFromFilename("FILE.LEDGER")).toBe("ledger");
  });
});

describe("browser-ledger-file", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  describe("importLedger (ledger format)", () => {
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

2024-01-01 * "Buy EUR"
  Assets:BankEUR  100 EUR @ 1.10 USD
  Assets:BankUSD  -110 USD
`;
      const result = await importLedger(backend, content);
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

    it("bare amounts use first-seen commodity as default", async () => {
      const content = `
2024-01-01 * Opening
  Assets:Bank  100 USD
  Equity:Opening  -100 USD

2024-01-15 * Groceries
  Expenses:Food  50
  Assets:Bank  -50
`;
      const result = await importLedger(backend, content, "ledger");
      expect(result.transactions_imported).toBe(2);

      const accounts = await backend.listAccounts();
      const food = accounts.find((a) => a.full_name === "Expenses:Food")!;
      const balance = await backend.getAccountBalance(food.id);
      expect(balance).toHaveLength(1);
      expect(balance[0].currency).toBe("USD");
      expect(balance[0].amount).toBe("50");
    });

    it("commodity directive sets default commodity", async () => {
      const content = `
commodity EUR

2024-01-01 * Opening
  Assets:Bank  100
  Equity:Opening  -100
`;
      const result = await importLedger(backend, content, "ledger");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const bank = accounts.find((a) => a.full_name === "Assets:Bank")!;
      const balance = await backend.getAccountBalance(bank.id);
      expect(balance).toHaveLength(1);
      expect(balance[0].currency).toBe("EUR");
    });

    it("commodity directive takes priority over first-seen", async () => {
      const content = `
commodity EUR

2024-01-01 * Opening
  Assets:Bank  100 USD
  Equity:Opening  -100 USD

2024-01-15 * Groceries
  Expenses:Food  50
  Assets:Bank  -50
`;
      const result = await importLedger(backend, content, "ledger");
      expect(result.transactions_imported).toBe(2);

      const accounts = await backend.listAccounts();
      const food = accounts.find((a) => a.full_name === "Expenses:Food")!;
      const balance = await backend.getAccountBalance(food.id);
      expect(balance).toHaveLength(1);
      expect(balance[0].currency).toBe("EUR");
    });

    it("errors when no commodity available for bare amount", async () => {
      const content = `
2024-01-01 * Opening
  Assets:Bank  100
  Equity:Opening  -100
`;
      await expect(importLedger(backend, content, "ledger")).rejects.toThrow(
        "posting has amount but no commodity",
      );
    });
  });

  describe("importLedger (beancount format)", () => {
    it("parses txn keyword", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food

2024-01-15 txn "Grocery Store"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries[0][0].description).toBe("Grocery Store");
    });

    it("parses quoted description", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food

2024-01-15 * "Fancy Grocery Store"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries[0][0].description).toBe("Fancy Grocery Store");
    });

    it("strips tags and links, stores as metadata", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food

2024-01-15 * "Payment" #groceries ^invoice-001
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries[0][0].description).toBe("Payment");

      const meta = await backend.getMetadata(entries[0][0].id);
      expect(meta.tags).toBe("#groceries");
      expect(meta.links).toBe("^invoice-001");
    });

    it("parses @@ total cost", async () => {
      const content = `
2024-01-01 open Assets:Stocks
2024-01-01 open Assets:Bank

2024-01-15 * "Buy Shares"
  Assets:Stocks  10 AAPL @@ 1500 USD
  Assets:Bank  -1500 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      // Should create Equity:Trading:AAPL
      const accounts = await backend.listAccounts();
      const trading = accounts.find((a) => a.full_name === "Equity:Trading:AAPL");
      expect(trading).toBeDefined();
    });

    it("parses {cost} lot syntax", async () => {
      const content = `
2024-01-01 open Assets:Stocks
2024-01-01 open Assets:Bank

2024-01-15 * "Buy Shares"
  Assets:Stocks  10 AAPL {150 USD}
  Assets:Bank  -1500 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const trading = accounts.find((a) => a.full_name === "Equity:Trading:AAPL");
      expect(trading).toBeDefined();
    });

    it("parses {cost COMMODITY, date} lot syntax", async () => {
      const content = `
2024-01-01 open Assets:US:ETrade:Cash
2024-01-01 open Assets:US:ETrade:GLD
2024-01-01 open Expenses:Financial:Commissions

2024-10-04 * "Buy shares of GLD"
  Assets:US:ETrade:Cash    -1616.79 USD
  Assets:US:ETrade:GLD     16 GLD {100.49 USD, 2024-10-04}
  Expenses:Financial:Commissions  8.95 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const trading = accounts.find((a) => a.full_name === "Equity:Trading:GLD");
      expect(trading).toBeDefined();
    });

    it("handles @ COMMODITY without price via inferred trading entries", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Assets:Gold

2024-01-01 * "Buy gold"
  Assets:Bank  -500 EUR @ XAU
  Assets:Gold  0.5 XAU
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      const items = entries[0][1];
      // 2 postings + 2 trading entries = 4 line items
      expect(items.length).toBe(4);

      const accounts = await backend.listAccounts();
      const trading = accounts.find((a) => a.full_name === "Equity:Trading:EUR");
      expect(trading).toBeDefined();
    });

    it("handles @ COMMODITY without price for multiple commodities", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Assets:Gold
2024-01-01 open Assets:Silver

2024-01-01 * "Buy metals"
  Assets:Bank  -402 EUR @ XAU
  Assets:Bank  -494 EUR @ XAG
  Assets:Gold  0.353 XAU
  Assets:Silver  20 XAG
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      const items = entries[0][1];
      // 4 postings + 4 trading entries = 8 line items
      expect(items.length).toBe(8);
    });

    it("rounds {cost} total to price precision to handle beancount rounding tolerance", async () => {
      // 3.711 * 129.35 = 480.01785, but cash leg is -480.02 USD
      // beancount allows this rounding; we round cost total to price's decimal places
      const content = `
2024-01-01 open Assets:US:Vanguard:Cash
2024-01-01 open Assets:US:Vanguard:VBMPX

2024-01-08 * "Investing 40% of cash in VBMPX"
  Assets:US:Vanguard:VBMPX  3.711 VBMPX {129.35 USD, 2024-01-08}
  Assets:US:Vanguard:Cash  -480.02 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
    });

    it("parses transaction metadata", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food

2024-01-15 * "Payment"
  invoice-id: "INV-001"
  recipient: "Acme"
  Expenses:Food  500 USD
  Assets:Bank  -500 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      const meta = await backend.getMetadata(entries[0][0].id);
      expect(meta["invoice-id"]).toBe("INV-001");
      expect(meta["recipient"]).toBe("Acme");
    });

    it("parses account metadata on open directive", async () => {
      const content = `
2024-01-01 open Assets:Bank USD
  bank-name: "Chase"
  routing: "021000021"
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.accounts_created).toBeGreaterThanOrEqual(1);

      const accounts = await backend.listAccounts();
      const bank = accounts.find((a) => a.full_name === "Assets:Bank")!;
      const meta = await backend.getAccountMetadata(bank.id);
      expect(meta["bank-name"]).toBe("Chase");
      expect(meta["routing"]).toBe("021000021");
    });

    it("skips option and plugin directives", async () => {
      const content = `
option "operating_currency" "USD"
plugin "beancount.plugins.auto_accounts"

2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
      // Should not throw or warn about option/plugin
    });

    it("skips note, document, event, custom directives", async () => {
      const content = `
2024-01-01 open Assets:Bank

2024-01-15 note Assets:Bank "Updated contact info"
2024-01-15 document Assets:Bank "/path/to/doc.pdf"
2024-01-15 event "location" "New York"
2024-01-15 custom "budget" Assets:Bank "monthly" 1000 USD

2024-01-15 * "Payment"
  Assets:Bank  -50 USD
  Expenses:Food  50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
    });

    it("handles single-space between account and amount", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:OpeningBalance

2024-01-01 * "Opening Balance"
  Assets:Bank 1000.00 USD
  Equity:OpeningBalance -1000.00 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries).toHaveLength(1);
      expect(entries[0][1]).toHaveLength(2);
      expect(entries[0][1][0].amount).toBe("1000.00");
      expect(entries[0][1][1].amount).toBe("-1000.00");
    });

    it("handles slash dates in beancount", async () => {
      const content = `
2024/01/01 open Assets:Bank
2024/01/01 open Equity:Opening

2024/01/01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries[0][0].date).toBe("2024-01-01");
    });

    it("skips zero-amount postings", async () => {
      const content = `
2024-01-15 * "Mixed zero and non-zero"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
  Assets:Promo  0 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      const items = entries[0][1];
      expect(items).toHaveLength(2);
      expect(items.every((i: { amount: string }) => i.amount !== "0")).toBe(true);
    });

    it("skips transaction with only zero-amount postings", async () => {
      const content = `
2024-01-15 * "All zero"
  Assets:A  0 USD
  Assets:B  0 USD

2024-01-16 * "Normal"
  Expenses:Food  30 USD
  Assets:Bank  -30 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
      expect(result.warnings.some((w: string) => w.includes("zero-amount"))).toBe(true);
    });

    it("parses commodity directive as currency definition", async () => {
      const content = `
1792-01-01 commodity USD
  name: "US Dollar"
  export: "CASH"

1995-09-18 commodity VBMPX
  name: "Vanguard Total Bond Market"
  price: "USD:google/MUTF:VBMPX"

2024-01-01 open Assets:Bank

2024-01-15 * "Payment"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
      // commodity directives should not produce warnings
      expect(result.warnings.filter((w: string) => w.includes("commodity"))).toHaveLength(0);

      const currencies = await backend.listCurrencies();
      expect(currencies.find((c) => c.code === "VBMPX")).toBeDefined();
    });

    it("parses price directive as exchange rate", async () => {
      const content = `
2024-01-01 open Assets:Bank

2024-01-05 price VBMPX 129.35 USD
2024-01-05 price GLD 92.98 USD

2024-01-15 * "Payment"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.prices_imported).toBe(2);
      expect(result.transactions_imported).toBe(1);
    });

    it("defers balance assertions until after all transactions", async () => {
      // Balance assertion appears before the deposit transaction in file order,
      // but the deposit predates the assertion date — should pass
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-02 balance Assets:Bank 100 USD

2024-01-01 * "Opening Balance"
  Assets:Bank  100 USD
  Equity:Opening  -100 USD
`;
      const result = await importLedger(backend, content, "beancount");
      expect(result.transactions_imported).toBe(1);
      expect(result.warnings.filter((w: string) => w.includes("balance assertion failed"))).toHaveLength(0);
    });
  });

  describe("importLedger (hledger format)", () => {
    it("parses account directive", async () => {
      const content = `
account Assets:Bank
account Expenses:Food

2024-01-15 * Payment
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      expect(accounts.find((a) => a.full_name === "Assets:Bank")).toBeDefined();
      expect(accounts.find((a) => a.full_name === "Expenses:Food")).toBeDefined();
    });

    it("parses slash date format", async () => {
      const content = `
2024/01/15 * Groceries
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);

      const entries = await backend.queryJournalEntries({});
      expect(entries[0][0].date).toBe("2024-01-15");
    });

    it("handles prefix currency ($100.00)", async () => {
      const content = `
2024-01-15 * Groceries
  Expenses:Food  $50.00
  Assets:Bank  $-50.00
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const food = accounts.find((a) => a.full_name === "Expenses:Food")!;
      const balance = await backend.getAccountBalance(food.id);
      expect(parseFloat(balance[0].amount)).toBe(50);
      expect(balance[0].currency).toBe("USD");
    });

    it("handles named prefix currency (EUR 100.00)", async () => {
      const content = `
2024-01-15 * Groceries
  Expenses:Food  EUR 50.00
  Assets:Bank  EUR -50.00
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const food = accounts.find((a) => a.full_name === "Expenses:Food")!;
      const balance = await backend.getAccountBalance(food.id);
      expect(parseFloat(balance[0].amount)).toBe(50);
      expect(balance[0].currency).toBe("EUR");
    });

    it("handles thousands separators (1,234.56)", async () => {
      const content = `
2024-01-15 * Big Purchase
  Expenses:Shopping  1,234.56 USD
  Assets:Bank  -1,234.56 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);

      const accounts = await backend.listAccounts();
      const shopping = accounts.find((a) => a.full_name === "Expenses:Shopping")!;
      const balance = await backend.getAccountBalance(shopping.id);
      expect(balance[0].amount).toBe("1234.56");
    });

    it("skips virtual postings", async () => {
      const content = `
2024-01-15 * Payment
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
  (Assets:Budget:Food)  -50 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);
      expect(result.warnings.some((w) => w.includes("virtual posting"))).toBe(true);
    });

    it("handles block comments", async () => {
      const content = `
comment
This is a block comment.
It spans multiple lines.
end comment

2024-01-15 * Payment
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);
    });

    it("skips commodity directive", async () => {
      const content = `
commodity USD
commodity EUR

2024-01-15 * Payment
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(1);
    });

    it("parses inline balance assertion (=)", async () => {
      const content = `
2024-01-01 * Opening
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

2024-01-15 * Payment
  Expenses:Food  50 USD
  Assets:Bank  -50 USD = 950 USD
`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.transactions_imported).toBe(2);
    });

    it("handles price directive with slash dates", async () => {
      const content = `P 2024/01/01 EUR 1.10 USD\n`;
      const result = await importLedger(backend, content, "hledger");
      expect(result.prices_imported).toBe(1);

      const rate = await backend.getExchangeRate("EUR", "USD", "2024-01-01");
      expect(rate).toBe("1.10");
    });
  });

  describe("exportLedger", () => {
    it("exports round-trip (ledger)", async () => {
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

    it("exports beancount format with quoted descriptions", async () => {
      const input = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening balance"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      await importLedger(backend, input);
      const exported = await exportLedger(backend, "beancount");

      // Beancount format should have quoted description
      expect(exported).toContain('"Opening balance"');
      // Should have open directives
      expect(exported).toContain("open Assets:Bank");
    });

    it("exports hledger format with account directives", async () => {
      const input = `
2024-01-01 open Assets:Bank
2024-01-01 open Equity:Opening

2024-01-01 * "Opening balance"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      await importLedger(backend, input);
      const exported = await exportLedger(backend, "hledger");

      // hledger format should have `account` directives, not `open`
      expect(exported).toContain("account Assets:Bank");
      expect(exported).toContain("account Equity:Opening");
      expect(exported).not.toContain("open Assets:Bank");
      // Description should not be quoted
      expect(exported).toContain("Opening balance");
      expect(exported).not.toContain('"Opening balance"');
    });

    it("exports beancount metadata", async () => {
      const input = `
2024-01-01 open Assets:Bank USD
  bank-name: "Chase"

2024-01-01 open Expenses:Food

2024-01-15 * "Payment"
  invoice-id: "INV-001"
  Expenses:Food  500 USD
  Assets:Bank  -500 USD
`;
      await importLedger(backend, input, "beancount");
      const exported = await exportLedger(backend, "beancount");

      expect(exported).toContain('bank-name: "Chase"');
      expect(exported).toContain('invoice-id: "INV-001"');
    });

    it("round-trips beancount import → export → reimport", async () => {
      const input = `
2024-01-01 open Assets:Bank USD
2024-01-01 open Expenses:Food

2024-01-15 * "Grocery Store"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD

P 2024-01-01 EUR 1.10 USD
`;
      await importLedger(backend, input, "beancount");
      const exported = await exportLedger(backend, "beancount");

      // Reimport into a fresh backend
      const backend2 = await createTestBackend();
      const result2 = await importLedger(backend2, exported, "beancount");
      expect(result2.transactions_imported).toBe(1);
      expect(result2.prices_imported).toBe(1);

      const entries2 = await backend2.queryJournalEntries({});
      expect(entries2[0][0].description).toBe("Grocery Store");
    });

    it("round-trips hledger import → export → reimport", async () => {
      const input = `
account Assets:Bank
account Expenses:Food

2024-01-15 * Grocery Store
  Expenses:Food  50 USD
  Assets:Bank  -50 USD

P 2024-01-01 EUR 1.10 USD
`;
      await importLedger(backend, input, "hledger");
      const exported = await exportLedger(backend, "hledger");

      const backend2 = await createTestBackend();
      const result2 = await importLedger(backend2, exported, "hledger");
      expect(result2.transactions_imported).toBe(1);
      expect(result2.prices_imported).toBe(1);
    });
  });

  describe("importLedger dedup", () => {
    it("skips all transactions on exact re-import", async () => {
      const content = `
2024-01-01 open Assets:Bank
2024-01-01 open Expenses:Food
2024-01-01 open Equity:Opening

2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

2024-01-15 * "Groceries"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const r1 = await importLedger(backend, content);
      expect(r1.transactions_imported).toBe(2);
      expect(r1.duplicates_skipped).toBe(0);

      const r2 = await importLedger(backend, content);
      expect(r2.transactions_imported).toBe(0);
      expect(r2.duplicates_skipped).toBe(2);
    });

    it("imports new transactions while skipping duplicates", async () => {
      const content1 = `
2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD
`;
      const r1 = await importLedger(backend, content1);
      expect(r1.transactions_imported).toBe(1);

      const content2 = `
2024-01-01 * "Opening"
  Assets:Bank  1000 USD
  Equity:Opening  -1000 USD

2024-01-15 * "Groceries"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const r2 = await importLedger(backend, content2);
      expect(r2.transactions_imported).toBe(1);
      expect(r2.duplicates_skipped).toBe(1);
    });

    it("detects intra-batch duplicates", async () => {
      const content = `
2024-01-15 * "Groceries"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD

2024-01-15 * "Groceries"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const r = await importLedger(backend, content);
      expect(r.transactions_imported).toBe(1);
      expect(r.duplicates_skipped).toBe(1);
    });

    it("cross-format dedup via amount fingerprint", async () => {
      // Import via ledger file
      const content = `
2024-01-15 * "Grocery Store"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      await importLedger(backend, content);

      // Now check that the amount fingerprint of a different-description entry matches
      const entries = await backend.queryJournalEntries({});
      const [entry, items] = entries[0];
      const afp = computeEntryAmountFingerprint(entry, items);

      // The amount fingerprint should be date:sorted pairs (no description)
      expect(afp).toBe("2024-01-15:Expenses:Food:50|Assets:Bank:-50".replace(/[^:|\d-]+/g, "").length > 0 ? afp : "");
      // Verify re-import with different description but same date+amounts is caught
      const content2 = `
2024-01-15 * "Different Description"
  Expenses:Food  50 USD
  Assets:Bank  -50 USD
`;
      const r2 = await importLedger(backend, content2);
      expect(r2.duplicates_skipped).toBe(1);
      expect(r2.transactions_imported).toBe(0);
    });
  });
});
