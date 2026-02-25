import { describe, it, expect } from "vitest";
import {
  parseDeblockStatement,
  parseDeblockAmount,
  parseFrenchDate,
} from "./deblock.js";
import type { PdfPage, PdfTextItem, PdfTextLine } from "../types.js";

function makeItem(str: string, x: number, y: number): PdfTextItem {
  return { str, x, y, width: str.length * 6, height: 10, fontName: "Arial" };
}

function makeLine(y: number, ...items: [string, number][]): PdfTextLine {
  return {
    y,
    items: items.map(([str, x]) => makeItem(str, x, y)),
  };
}

function makePage(lines: PdfTextLine[], pageNumber = 1): PdfPage {
  return { pageNumber, lines };
}

// Deblock identifiers
const DEBLOCK_ID = makeLine(691.8, ["BIC", 273.8], ["DBLKFR22XXX", 290.5]);
const PERIOD = makeLine(617.7, ["Transactions du compte du 1 mars 2025 au 1 avril 2025", 66.8]);
const IBAN_LINE = makeLine(703.9, ["IBAN", 273.8], ["FR00 1774 8019 0000 0000 0000 000", 296.4]);

// Column header
const COL_HEADER = makeLine(577.5,
  ["Date", 66.0], ["Valeur", 145.7], ["Opération", 225.3], ["Débit", 384.6], ["Crédit", 424.4],
);

// ─── Amount parsing ─────────────────────────────────────────────────────────

describe("parseDeblockAmount", () => {
  it("parses simple amount", () => {
    expect(parseDeblockAmount("7,19")).toBe(7.19);
  });

  it("parses amount with space thousands separator", () => {
    expect(parseDeblockAmount("1 203,55")).toBe(1203.55);
  });

  it("parses large amount with space separator", () => {
    expect(parseDeblockAmount("19 401,00")).toBe(19401);
  });

  it("parses amount with euro suffix", () => {
    expect(parseDeblockAmount("26,80 €")).toBe(26.8);
  });

  it("parses amount with EUR suffix", () => {
    expect(parseDeblockAmount("1 641,61 EUR")).toBe(1641.61);
  });

  it("parses integer-like amount", () => {
    expect(parseDeblockAmount("5 000,00")).toBe(5000);
  });

  it("returns null for empty string", () => {
    expect(parseDeblockAmount("")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseDeblockAmount("abc")).toBeNull();
  });

  it("returns null for just euro sign", () => {
    expect(parseDeblockAmount("€")).toBeNull();
  });
});

// ─── French date parsing ────────────────────────────────────────────────────

describe("parseFrenchDate", () => {
  it("parses single-digit day", () => {
    expect(parseFrenchDate("6 mars 2025")).toBe("2025-03-06");
  });

  it("parses double-digit day", () => {
    expect(parseFrenchDate("19 juillet 2025")).toBe("2025-07-19");
  });

  it("parses January", () => {
    expect(parseFrenchDate("1 janvier 2024")).toBe("2024-01-01");
  });

  it("parses accented months", () => {
    expect(parseFrenchDate("15 février 2025")).toBe("2025-02-15");
    expect(parseFrenchDate("1 décembre 2024")).toBe("2024-12-01");
    expect(parseFrenchDate("10 août 2025")).toBe("2025-08-10");
  });

  it("parses unaccented variants", () => {
    expect(parseFrenchDate("15 fevrier 2025")).toBe("2025-02-15");
  });

  it("returns null for invalid format", () => {
    expect(parseFrenchDate("31/01")).toBeNull();
    expect(parseFrenchDate("2025-03-06")).toBeNull();
    expect(parseFrenchDate("random text")).toBeNull();
  });

  it("returns null for unknown month", () => {
    expect(parseFrenchDate("1 foobar 2025")).toBeNull();
  });
});

// ─── Statement parsing ──────────────────────────────────────────────────────

describe("parseDeblockStatement", () => {
  it("returns warnings for empty pages", () => {
    const result = parseDeblockStatement([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No pages found in PDF");
  });

  it("returns warning for non-Deblock PDF", () => {
    const page = makePage([makeLine(400, ["Random PDF content", 40])]);
    const result = parseDeblockStatement([page]);
    expect(result.warnings).toContain("Not a Deblock statement");
  });

  it("parses single debit transaction", () => {
    const page = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      PERIOD,
      COL_HEADER,
      makeLine(556.5,
        ["6 mars 2025", 66.0], ["6 mars 2025", 145.7],
        ['Paiement Carte "example.com"', 225.3], ["7,19", 384.6],
      ),
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["26,80 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2025-03-06");
    expect(result.transactions[0].description).toBe('Paiement Carte "example.com"');
    expect(result.transactions[0].amount).toBe(-7.19);
    expect(result.transactions[0].index).toBe(0);
  });

  it("parses single credit transaction", () => {
    const page = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      PERIOD,
      COL_HEADER,
      makeLine(556.5,
        ["7 mars 2025", 66.0], ["7 mars 2025", 145.7],
        ['Virement "DUPONT Marie"', 225.3], ["48,00", 424.4],
      ),
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["48,00 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(48);
    expect(result.transactions[0].description).toContain("Virement");
  });

  it("classifies debit vs credit by column position", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      makeLine(556.5,
        ["6 mars 2025", 66.0], ["6 mars 2025", 145.7],
        ["Expense", 225.3], ["50,00", 384.6],
      ),
      makeLine(535.5,
        ["7 mars 2025", 66.0], ["7 mars 2025", 145.7],
        ["Income", 225.3], ["200,00", 424.4],
      ),
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["150,00 €", 432.4]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].amount).toBe(-50); // debit = negative
    expect(result.transactions[1].amount).toBe(200); // credit = positive
  });

  it("handles multi-line operation (description above date line)", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      // Multi-line: description starts on line above the date/amount line
      makeLine(556.5, ['Prélèvement automatique "EXAMPLE TAX OFFICE', 225.3]),
      makeLine(553.2,
        ["15 octobre 2025", 66.0], ["14 octobre 2025", 145.7], ["19 401,00", 384.6],
      ),
      makeLine(549.8, ['OF FRANCE"', 225.3]),
      makeLine(200, ["Solde créditeur au 1 novembre 2025", 66.0], ["4 794,77 €", 432.4]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2025-10-15");
    expect(result.transactions[0].amount).toBe(-19401);
    expect(result.transactions[0].description).toContain("Prélèvement automatique");
    expect(result.transactions[0].description).toContain("OF FRANCE");
  });

  it("handles empty statement (no transactions)", () => {
    const page = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      makeLine(617.7, ["Transactions du compte du 1 octobre 2024 au 1 novembre 2024", 66.8]),
      COL_HEADER,
      makeLine(544.3, ["Solde créditeur au 1 novembre 2024", 66.0]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(0);
    expect(result.closingBalance).toBeNull(); // no amount on balance line
    expect(result.closingDate).toBe("2024-11-01");
  });

  it("extracts IBAN", () => {
    const page = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      PERIOD,
      COL_HEADER,
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["0,00 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);
    expect(result.iban).toBe("FR0017748019000000000000000");
  });

  it("extracts period dates", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["0,00 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);
    expect(result.openingDate).toBe("2025-03-01");
    expect(result.closingDate).toBe("2025-04-01");
  });

  it("extracts closing balance", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["1 641,61 €", 432.4]),
    ]);

    const result = parseDeblockStatement([page]);
    expect(result.closingBalance).toBe(1641.61);
    expect(result.closingDate).toBe("2025-04-01");
  });

  it("handles multi-page with repeated column headers", () => {
    const page1 = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      PERIOD,
      COL_HEADER,
      makeLine(556.5,
        ["6 mars 2025", 66.0], ["6 mars 2025", 145.7],
        ['Paiement Carte "shop1"', 225.3], ["10,00", 384.6],
      ),
    ], 1);

    const page2Header = makeLine(793.5,
      ["Date", 66.0], ["Valeur", 145.7], ["Opération", 225.3], ["Débit", 384.6], ["Crédit", 424.4],
    );
    const page2 = makePage([
      page2Header,
      makeLine(772.5,
        ["15 mars 2025", 66.0], ["15 mars 2025", 145.7],
        ['Virement "Alice"', 225.3], ["500,00", 424.4],
      ),
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["490,00 €", 432.4]),
    ], 2);

    const result = parseDeblockStatement([page1, page2]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].description).toContain("shop1");
    expect(result.transactions[0].amount).toBe(-10);
    expect(result.transactions[1].description).toContain("Alice");
    expect(result.transactions[1].amount).toBe(500);
  });

  it("parses multiple transactions", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      makeLine(556.5,
        ["6 mars 2025", 66.0], ["6 mars 2025", 145.7],
        ['Paiement Carte "example.com"', 225.3], ["7,19", 384.6],
      ),
      makeLine(535.5,
        ["7 mars 2025", 66.0], ["7 mars 2025", 145.7],
        ['Virement "DUPONT Marie"', 225.3], ["48,00", 424.4],
      ),
      makeLine(514.5,
        ["10 mars 2025", 66.0], ["10 mars 2025", 145.7],
        ["Cashback", 225.3], ["0,07", 424.4],
      ),
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["40,88 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);

    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].amount).toBe(-7.19);
    expect(result.transactions[1].amount).toBe(48);
    expect(result.transactions[2].amount).toBe(0.07);
  });

  it("defaults currency to EUR", () => {
    const page = makePage([DEBLOCK_ID, COL_HEADER]);
    const result = parseDeblockStatement([page]);
    expect(result.currency).toBe("EUR");
  });

  it("has no opening balance (not in Deblock format)", () => {
    const page = makePage([
      DEBLOCK_ID,
      PERIOD,
      COL_HEADER,
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["100,00 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);
    expect(result.openingBalance).toBeNull();
  });

  it("has no account number (Deblock uses IBAN only)", () => {
    const page = makePage([
      DEBLOCK_ID,
      IBAN_LINE,
      PERIOD,
      COL_HEADER,
      makeLine(200, ["Solde créditeur au 1 avril 2025", 66.0], ["100,00 €", 441.8]),
    ]);

    const result = parseDeblockStatement([page]);
    expect(result.accountNumber).toBeNull();
  });
});
