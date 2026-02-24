import { describe, it, expect, beforeEach } from "vitest";
import { transformGeneric, importRecords } from "./transform.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

describe("transformGeneric", () => {
  it("transforms basic CSV rows to records", () => {
    const headers = ["Date", "Description", "Amount"];
    const rows = [
      ["2024-01-15", "Coffee", "5.00"],
      ["2024-01-16", "Grocery", "25.00"],
    ];

    const result = transformGeneric(headers, rows, {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: "Description",
      amountColumn: "Amount",
      mainAccount: "Assets:Bank",
      counterAccount: "Expenses:Food",
    });

    expect(result.records).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
    expect(result.records[0].date).toBe("2024-01-15");
    expect(result.records[0].lines).toHaveLength(2);
    expect(result.records[0].lines[0].amount).toBe("5");
    expect(result.records[0].lines[1].amount).toBe("-5");
  });

  it("warns on invalid dates", () => {
    const result = transformGeneric(["Date", "Amount"], [["bad", "100"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid date");
  });

  it("handles split debit/credit columns", () => {
    const headers = ["Date", "Debit", "Credit"];
    const rows = [
      ["2024-01-15", "50.00", ""],
      ["2024-01-16", "", "100.00"],
    ];

    const result = transformGeneric(headers, rows, {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      debitAmountColumn: "Debit",
      creditAmountColumn: "Credit",
    });

    expect(result.records).toHaveLength(2);
    // Debit row: debit=50, credit empty → amount = -50 (debit subtracts)
    // But transformGeneric with debit only: debit>0 → amount = debit → 50 goes negative via the split logic
    // Actually: debit=50 → amount = 50 → recorded on mainAccount
    expect(parseFloat(result.records[0].lines[0].amount)).toBe(50);
    // Credit row: debit empty, credit=100 → amount = -100
    expect(parseFloat(result.records[1].lines[0].amount)).toBe(-100);
  });

  it("uses fixedCurrency", () => {
    const result = transformGeneric(["Date", "Amount"], [["2024-01-15", "100"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
      fixedCurrency: "EUR",
    });

    expect(result.records[0].lines[0].currency).toBe("EUR");
  });

  it("uses currencyColumn", () => {
    const result = transformGeneric(["Date", "Amount", "Ccy"], [["2024-01-15", "100", "BTC"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
      currencyColumn: "Ccy",
    });

    expect(result.records[0].lines[0].currency).toBe("BTC");
  });

  it("handles European number format", () => {
    const result = transformGeneric(["Date", "Amount"], [["2024-01-15", "1.234,56"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
      europeanNumbers: true,
    });

    expect(result.records[0].lines[0].amount).toBe("1234.56");
  });

  it("skips empty rows", () => {
    const result = transformGeneric(["Date", "Amount"], [[""], ["2024-01-15", "100"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
    });

    expect(result.records).toHaveLength(1);
  });

  it("warns on zero amounts", () => {
    const result = transformGeneric(["Date", "Amount"], [["2024-01-15", "0"]], {
      dateColumn: "Date",
      dateFormat: "YYYY-MM-DD",
      amountColumn: "Amount",
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("importRecords", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("imports records and creates accounts/currencies", async () => {
    const records = [
      {
        date: "2024-01-15",
        description: "Test",
        lines: [
          { account: "Expenses:Food", currency: "USD", amount: "50" },
          { account: "Assets:Bank", currency: "USD", amount: "-50" },
        ],
      },
    ];

    const result = await importRecords(backend, records);
    expect(result.entries_created).toBe(1);
    expect(result.accounts_created).toBeGreaterThan(0);
  });

  it("skips unbalanced records", async () => {
    const records = [
      {
        date: "2024-01-15",
        description: "Test",
        lines: [
          { account: "Expenses:Food", currency: "USD", amount: "50" },
        ],
      },
    ];

    const result = await importRecords(backend, records);
    expect(result.entries_created).toBe(0);
  });

  it("groups records by groupKey", async () => {
    const records = [
      {
        date: "2024-01-15",
        description: "Trade",
        lines: [{ account: "Assets:BTC", currency: "BTC", amount: "1" }],
        groupKey: "trade-1",
      },
      {
        date: "2024-01-15",
        description: "Trade",
        lines: [{ account: "Assets:USD", currency: "USD", amount: "-50000" }],
        groupKey: "trade-1",
      },
      {
        date: "2024-01-15",
        description: "Trade",
        lines: [
          { account: "Equity:Trading", currency: "BTC", amount: "-1" },
          { account: "Equity:Trading", currency: "USD", amount: "50000" },
        ],
        groupKey: "trade-1",
      },
    ];

    const result = await importRecords(backend, records);
    expect(result.entries_created).toBe(1); // grouped into single entry
  });

  it("sets source with presetId", async () => {
    const records = [
      {
        date: "2024-01-15",
        description: "Test",
        lines: [
          { account: "Expenses:Food", currency: "USD", amount: "50" },
          { account: "Assets:Bank", currency: "USD", amount: "-50" },
        ],
        sourceKey: "ref123",
      },
    ];

    const result = await importRecords(backend, records, "kraken-ledger");
    expect(result.entries_created).toBe(1);
    const entries = await backend.queryJournalEntries({});
    expect(entries[0][0].source).toBe("csv-import:kraken-ledger:ref123");
  });

  it("returns empty result for empty records", async () => {
    const result = await importRecords(backend, []);
    expect(result.entries_created).toBe(0);
  });
});
