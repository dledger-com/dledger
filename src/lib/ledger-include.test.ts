import { describe, it, expect } from "vitest";
import { resolveIncludes, filterLedgerFiles, LEDGER_EXTENSIONS } from "./ledger-include.js";

describe("resolveIncludes", () => {
  it("replaces include directive with file content", () => {
    const main = `; main file\ninclude accounts.ledger\n\n2024-01-15 * Payment\n  Expenses:Food  50 USD\n  Assets:Bank  -50 USD`;
    const fileMap = new Map([
      ["accounts.ledger", "2024-01-01 open Assets:Bank\n2024-01-01 open Expenses:Food"],
    ]);
    const result = resolveIncludes(main, fileMap);
    expect(result).toContain("2024-01-01 open Assets:Bank");
    expect(result).toContain("2024-01-01 open Expenses:Food");
    expect(result).not.toContain("include accounts.ledger");
  });

  it("handles quoted include paths", () => {
    const main = `include "accounts.ledger"\ninclude 'prices.ledger'`;
    const fileMap = new Map([
      ["accounts.ledger", "account Assets:Bank"],
      ["prices.ledger", "P 2024-01-01 EUR 1.10 USD"],
    ]);
    const result = resolveIncludes(main, fileMap);
    expect(result).toContain("account Assets:Bank");
    expect(result).toContain("P 2024-01-01 EUR 1.10 USD");
  });

  it("resolves basename when exact path not found", () => {
    const main = `include path/to/accounts.ledger`;
    const fileMap = new Map([
      ["accounts.ledger", "2024-01-01 open Assets:Bank"],
    ]);
    const result = resolveIncludes(main, fileMap);
    expect(result).toContain("2024-01-01 open Assets:Bank");
  });

  it("adds warning for missing files", () => {
    const main = `include missing.ledger`;
    const fileMap = new Map<string, string>();
    const result = resolveIncludes(main, fileMap);
    expect(result).toContain("; WARNING: included file not found: missing.ledger");
  });

  it("resolves nested includes recursively", () => {
    const main = `include a.ledger`;
    const fileMap = new Map([
      ["a.ledger", "include b.ledger\naccount Assets:A"],
      ["b.ledger", "account Assets:B"],
    ]);
    const result = resolveIncludes(main, fileMap);
    expect(result).toContain("account Assets:A");
    expect(result).toContain("account Assets:B");
  });

  it("stops at max depth to prevent infinite loops", () => {
    const fileMap = new Map([
      ["a.ledger", "include b.ledger"],
      ["b.ledger", "include a.ledger"],
    ]);
    // Should not throw, just stop resolving at max depth
    const result = resolveIncludes("include a.ledger", fileMap);
    expect(result).toBeDefined();
  });

  it("leaves non-include lines unchanged", () => {
    const main = `2024-01-01 open Assets:Bank\n; a comment\n\n2024-01-15 * Payment\n  Expenses:Food  50 USD`;
    const fileMap = new Map<string, string>();
    const result = resolveIncludes(main, fileMap);
    expect(result).toBe(main);
  });
});

describe("filterLedgerFiles", () => {
  it("filters for ledger file extensions", () => {
    const entries = new Map([
      ["main.beancount", "content1"],
      ["readme.md", "# readme"],
      ["accounts.ledger", "content2"],
      ["data.csv", "col1,col2"],
      ["journal.journal", "content3"],
      ["extra.hledger", "content4"],
      ["notes.txt", "content5"],
      ["image.png", "binary"],
    ]);
    const result = filterLedgerFiles(entries);
    expect(result.map(([name]) => name)).toEqual([
      "accounts.ledger",
      "extra.hledger",
      "journal.journal",
      "main.beancount",
      "notes.txt",
    ]);
  });

  it("returns empty for no matching files", () => {
    const entries = new Map([
      ["readme.md", "# readme"],
      ["data.csv", "col1,col2"],
    ]);
    expect(filterLedgerFiles(entries)).toEqual([]);
  });

  it("sorts files alphabetically", () => {
    const entries = new Map([
      ["z-file.ledger", "z"],
      ["a-file.ledger", "a"],
      ["m-file.ledger", "m"],
    ]);
    const result = filterLedgerFiles(entries);
    expect(result.map(([name]) => name)).toEqual([
      "a-file.ledger",
      "m-file.ledger",
      "z-file.ledger",
    ]);
  });
});

describe("LEDGER_EXTENSIONS", () => {
  it("includes all expected extensions", () => {
    expect(LEDGER_EXTENSIONS.has(".beancount")).toBe(true);
    expect(LEDGER_EXTENSIONS.has(".journal")).toBe(true);
    expect(LEDGER_EXTENSIONS.has(".ledger")).toBe(true);
    expect(LEDGER_EXTENSIONS.has(".hledger")).toBe(true);
    expect(LEDGER_EXTENSIONS.has(".txt")).toBe(true);
  });

  it("rejects non-ledger extensions", () => {
    expect(LEDGER_EXTENSIONS.has(".csv")).toBe(false);
    expect(LEDGER_EXTENSIONS.has(".md")).toBe(false);
    expect(LEDGER_EXTENSIONS.has(".json")).toBe(false);
  });
});
