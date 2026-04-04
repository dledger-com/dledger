import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { parseCsv, importCsv, type CsvImportOptions } from "./csv-import.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

describe("parseCsv", () => {
  it("parses basic CSV with headers", () => {
    const { headers, rows } = parseCsv("name,age\nAlice,30\nBob,25");
    expect(headers).toEqual(["name", "age"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["Alice", "30"]);
  });

  it("handles quoted fields with commas", () => {
    const { rows } = parseCsv('name,desc\n"Smith, John","a ""quoted"" value"');
    expect(rows[0][0]).toBe("Smith, John");
    expect(rows[0][1]).toBe('a "quoted" value');
  });

  it("uses semicolon delimiter", () => {
    const { headers, rows } = parseCsv("a;b;c\n1;2;3", ";");
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual(["1", "2", "3"]);
  });

  it("handles empty input", () => {
    const { headers, rows } = parseCsv("");
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("skips blank lines", () => {
    const { rows } = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(rows).toHaveLength(2);
  });
});

describe("importCsv", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("imports basic two-line CSV entries", async () => {
    // Pre-create currencies
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,description,debit_account,credit_account,amount
2024-01-15,Groceries,Expenses:Food,Assets:Bank:Checking,50.00
2024-01-20,Salary,Assets:Bank:Checking,Income:Salary,3000.00`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      descriptionColumn: "description",
      lines: [
        { accountColumn: "debit_account", amountColumn: "amount", currencyColumn: "=USD" },
        { accountColumn: "credit_account", amountColumn: "amount", currencyColumn: "=USD", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(2);
    expect(result.accounts_created).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles fixed account mapping", async () => {
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,description,amount
2024-03-01,Coffee,5.00`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      descriptionColumn: "description",
      lines: [
        { accountColumn: "=Expenses:Food", amountColumn: "amount", currencyColumn: "=USD" },
        { accountColumn: "=Assets:Bank:Checking", amountColumn: "amount", currencyColumn: "=USD", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(1);
  });

  it("handles MM/DD/YYYY date format", async () => {
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,amount
01/15/2024,100.00`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      dateFormat: "MM/DD/YYYY",
      lines: [
        { accountColumn: "=Expenses:Misc", amountColumn: "amount", currencyColumn: "=USD" },
        { accountColumn: "=Assets:Bank", amountColumn: "amount", currencyColumn: "=USD", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(1);
    // Verify the date was parsed correctly
    const entries = await backend.queryJournalEntries({});
    expect(entries[0][0].date).toBe("2024-01-15");
  });

  it("warns on invalid dates", async () => {
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,amount
bad-date,100.00`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      lines: [
        { accountColumn: "=Expenses:Misc", amountColumn: "amount", currencyColumn: "=USD" },
        { accountColumn: "=Assets:Bank", amountColumn: "amount", currencyColumn: "=USD", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns on missing date column", async () => {
    const csv = `foo,bar\n1,2`;
    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      lines: [
        { accountColumn: "=Expenses:Misc", amountColumn: "bar", currencyColumn: "=USD" },
      ],
    });
    expect(result.entries_created).toBe(0);
    expect(result.warnings).toContain('Date column "date" not found');
  });

  it("auto-creates currencies", async () => {
    const csv = `date,currency,amount
2024-01-01,BTC,1.5`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      lines: [
        { accountColumn: "=Assets:Crypto", amountColumn: "amount", currencyColumn: "currency" },
        { accountColumn: "=Equity:Opening", amountColumn: "amount", currencyColumn: "currency", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(1);
    expect(result.currencies_created).toBeGreaterThan(0);
  });

  it("warns on unbalanced entries", async () => {
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,amount
2024-01-01,100.00`;

    // Only one line item -> unbalanced
    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      lines: [
        { accountColumn: "=Expenses:Misc", amountColumn: "amount", currencyColumn: "=USD" },
      ],
    });

    expect(result.entries_created).toBe(0);
    expect(result.warnings.some((w) => w.includes("don't balance"))).toBe(true);
  });

  it("handles amount with currency symbols and commas", async () => {
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true });

    const csv = `date,amount
2024-01-01,"$1,234.56"`;

    const result = await importCsv(backend, csv, {
      dateColumn: "date",
      lines: [
        { accountColumn: "=Assets:Bank", amountColumn: "amount", currencyColumn: "=USD" },
        { accountColumn: "=Income:Salary", amountColumn: "amount", currencyColumn: "=USD", amountNegate: true },
      ],
    });

    expect(result.entries_created).toBe(1);
  });
});
