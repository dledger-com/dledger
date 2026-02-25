import { describe, it, expect } from "vitest";
import { convertPdfToRecords, suggestMainAccount } from "./convert.js";
import type { PdfStatement } from "./types.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";

function makeStatement(overrides: Partial<PdfStatement> = {}): PdfStatement {
  return {
    accountNumber: "12 345 67X 000",
    iban: "FR0020041000010000000X000001",
    currency: "EUR",
    openingBalance: 522.92,
    openingDate: "2022-01-26",
    closingBalance: 631.6,
    closingDate: "2022-02-25",
    transactions: [
      {
        date: "2022-01-31",
        description: "ACHAT CB TOLLOPERATOR EXAMPLE 28.01.22 CARTE NUMERO 999",
        amount: -2.2,
        index: 0,
      },
      {
        date: "2022-02-02",
        description: "VIREMENT DE MLLE JANE DOE loyer",
        amount: 750,
        index: 1,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("convertPdfToRecords", () => {
  it("converts basic transactions", () => {
    const stmt = makeStatement();
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.records).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    const rec1 = result.records[0];
    expect(rec1.date).toBe("2022-01-31");
    expect(rec1.description).toContain("ACHAT CB TOLLOPERATOR");
    expect(rec1.lines).toHaveLength(2);
    expect(rec1.lines[0]).toEqual({
      account: "Assets:Banks:LBP",
      currency: "EUR",
      amount: "-2.2",
    });
    expect(rec1.lines[1]).toEqual({
      account: "Expenses:Uncategorized",
      currency: "EUR",
      amount: "2.2",
    });

    const rec2 = result.records[1];
    expect(rec2.date).toBe("2022-02-02");
    expect(rec2.lines[0].amount).toBe("750");
    expect(rec2.lines[1].account).toBe("Income:Uncategorized");
  });

  it("builds sourceKey from closingDate:txIndex", () => {
    const stmt = makeStatement();
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.records[0].sourceKey).toBe("2022-02-25:0");
    expect(result.records[1].sourceKey).toBe("2022-02-25:1");
  });

  it("applies categorization rules", () => {
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "TOLLOPERATOR", account: "Expenses:Transport:Tolls" },
      { id: "2", pattern: "loyer", account: "Income:Rent" },
    ];

    const stmt = makeStatement();
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules,
    });

    expect(result.records[0].lines[1].account).toBe("Expenses:Transport:Tolls");
    expect(result.records[1].lines[1].account).toBe("Income:Rent");
  });

  it("assigns expense for negative, income for positive amounts", () => {
    const stmt = makeStatement();
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.records[0].lines[1].account).toBe("Expenses:Uncategorized"); // -2.2
    expect(result.records[1].lines[1].account).toBe("Income:Uncategorized"); // +750
  });

  it("builds CsvFileHeader from balance info", () => {
    const stmt = makeStatement();
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.fileHeader.balanceDate).toBe("2022-02-25");
    expect(result.fileHeader.balanceAmount).toBe("631.6");
    expect(result.fileHeader.balanceCurrency).toBe("EUR");
    expect(result.fileHeader.mainAccount).toBe("Assets:Banks:LBP");
    expect(result.fileHeader.accountMetadata?.accountNumber).toBe("12 345 67X 000");
    expect(result.fileHeader.accountMetadata?.iban).toBe("FR0020041000010000000X000001");
  });

  it("handles empty statement", () => {
    const stmt = makeStatement({ transactions: [] });
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles statement without closing date", () => {
    const stmt = makeStatement({
      closingDate: null,
      closingBalance: null,
    });
    const result = convertPdfToRecords(stmt, {
      mainAccount: "Assets:Banks:LBP",
      rules: [],
    });

    expect(result.records[0].sourceKey).toBe("unknown:0");
    expect(result.fileHeader.balanceDate).toBeUndefined();
  });
});

describe("suggestMainAccount", () => {
  it("suggests account from account number", () => {
    const stmt = makeStatement();
    expect(suggestMainAccount(stmt)).toBe("Assets:Banks:LaBanquePostale:X000");
  });

  it("uses IBAN if no account number", () => {
    const stmt = makeStatement({ accountNumber: null });
    expect(suggestMainAccount(stmt)).toBe("Assets:Banks:LaBanquePostale:0001");
  });

  it("handles missing account info", () => {
    const stmt = makeStatement({ accountNumber: null, iban: null });
    expect(suggestMainAccount(stmt)).toBe("Assets:Banks:LaBanquePostale:Unknown");
  });

  it("suggests N26 account when bankId is n26", () => {
    const stmt = makeStatement();
    expect(suggestMainAccount(stmt, "n26")).toBe("Assets:Banks:N26");
  });

  it("preserves LBP behavior when bankId is lbp", () => {
    const stmt = makeStatement();
    expect(suggestMainAccount(stmt, "lbp")).toBe("Assets:Banks:LaBanquePostale:X000");
  });

  it("suggests Nuri account when bankId is nuri", () => {
    const stmt = makeStatement();
    expect(suggestMainAccount(stmt, "nuri")).toBe("Assets:Banks:Nuri");
  });
});
