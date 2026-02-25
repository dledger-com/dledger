import { describe, it, expect } from "vitest";
import {
  parseNuriStatement,
  parseNuriAmount,
  detectNuriFormat,
} from "./nuri.js";
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

// Old layout column header: Value Date | Booking Date | Action | Amount
const OLD_HEADER = makeLine(424,
  ["Value Date", 40], ["Booking Date", 148], ["Action", 256], ["Amount", 519],
);

// New layout column header: Action | Value Date | Booking Date | Amount
const NEW_HEADER = makeLine(371,
  ["Action", 40], ["Value Date", 258], ["Booking Date", 366], ["Amount", 516],
);

// solarisBank identifier line
const SOLARIS_LINE = makeLine(750, ["Statement of Account", 40]);

// ─── Amount parsing ─────────────────────────────────────────────────────────

describe("parseNuriAmount", () => {
  it("parses positive amount", () => {
    expect(parseNuriAmount("224.00")).toBe(224);
  });

  it("parses negative amount", () => {
    expect(parseNuriAmount("-1000.00")).toBe(-1000);
  });

  it("parses amount with EUR suffix", () => {
    expect(parseNuriAmount("28.00 EUR")).toBe(28);
  });

  it("parses zero", () => {
    expect(parseNuriAmount("0.00")).toBe(0);
  });

  it("parses decimal amount", () => {
    expect(parseNuriAmount("-48.50")).toBe(-48.5);
  });

  it("returns null for empty string", () => {
    expect(parseNuriAmount("")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseNuriAmount("abc")).toBeNull();
  });
});

// ─── Format detection ───────────────────────────────────────────────────────

describe("detectNuriFormat", () => {
  it("detects old format (Value Date first)", () => {
    const page = makePage([OLD_HEADER]);
    expect(detectNuriFormat([page])).toBe("old");
  });

  it("detects new format (Action first)", () => {
    const page = makePage([NEW_HEADER]);
    expect(detectNuriFormat([page])).toBe("new");
  });

  it("defaults to old format when no headers found", () => {
    const page = makePage([makeLine(400, ["Some text", 40])]);
    expect(detectNuriFormat([page])).toBe("old");
  });
});

// ─── Old format parser ──────────────────────────────────────────────────────

describe("parseNuriStatement — old format", () => {
  it("returns warnings for empty pages", () => {
    const result = parseNuriStatement([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No pages found in PDF");
  });

  it("returns warning for non-solarisBank PDF", () => {
    const page = makePage([makeLine(400, ["Random PDF content", 40])]);
    const result = parseNuriStatement([page]);
    expect(result.warnings).toContain("Not a solarisBank/Nuri/Bitwala statement");
  });

  it("parses incoming SEPA transfer (positive amount)", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/01/2021: 0.00 EUR", 40]),
      OLD_HEADER,
      makeLine(408, ["19/01/2021", 40], ["19/01/2021", 148], ["SEPA Credit Transfer", 256], ["224.00", 524]),
      makeLine(396, ["from MAX MUSTERMANN", 256]),
      makeLine(384, ["DE00700000000000000002", 256]),
      makeLine(372, ["147490", 256]),
      makeLine(149, ["Balance on 31/01/2021: 224.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2021-01-19");
    expect(result.transactions[0].description).toContain("SEPA Credit Transfer");
    expect(result.transactions[0].description).toContain("MAX MUSTERMANN");
    expect(result.transactions[0].amount).toBe(224);
    expect(result.transactions[0].index).toBe(0);
  });

  it("parses outgoing SEPA transfer (negative amount)", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/01/2021: 500.00 EUR", 40]),
      OLD_HEADER,
      makeLine(304, ["20/01/2021", 40], ["20/01/2021", 148], ["SEPA Credit Transfer", 256], ["-48.00", 524]),
      makeLine(292, ["to Erika Mustermann", 256]),
      makeLine(280, ["LT000000000000000003", 256]),
      makeLine(149, ["Balance on 31/01/2021: 452.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(-48);
    expect(result.transactions[0].description).toContain("Erika Mustermann");
  });

  it("parses multiple transactions", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/01/2021: 0.00 EUR", 40]),
      OLD_HEADER,
      makeLine(408, ["19/01/2021", 40], ["19/01/2021", 148], ["SEPA Credit Transfer", 256], ["224.00", 524]),
      makeLine(396, ["from Alice", 256]),
      makeLine(356, ["19/01/2021", 40], ["19/01/2021", 148], ["SEPA Credit Transfer", 256], ["315.00", 524]),
      makeLine(344, ["from Bob", 256]),
      makeLine(304, ["20/01/2021", 40], ["20/01/2021", 148], ["SEPA Credit Transfer", 256], ["-48.00", 524]),
      makeLine(292, ["to Charlie", 256]),
      makeLine(149, ["Balance on 31/01/2021: 491.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].amount).toBe(224);
    expect(result.transactions[1].amount).toBe(315);
    expect(result.transactions[2].amount).toBe(-48);
  });

  it("merges multi-line descriptions with commas", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/01/2021: 0.00 EUR", 40]),
      OLD_HEADER,
      makeLine(408, ["19/01/2021", 40], ["19/01/2021", 148], ["SEPA Credit Transfer", 256], ["224.00", 524]),
      makeLine(396, ["from MAX MUSTERMANN", 256]),
      makeLine(384, ["DE00700000000000000002", 256]),
      makeLine(372, ["Payment ref 100001", 256]),
      makeLine(149, ["Balance on 31/01/2021: 224.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe(
      "SEPA Credit Transfer, from MAX MUSTERMANN, DE00700000000000000002, Payment ref 100001",
    );
  });

  it("extracts opening and closing balance", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/01/2021: 100.50 EUR", 40]),
      OLD_HEADER,
      makeLine(149, ["Balance on 31/01/2021: 200.75 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.openingDate).toBe("2021-01-01");
    expect(result.openingBalance).toBe(100.5);
    expect(result.closingDate).toBe("2021-01-31");
    expect(result.closingBalance).toBe(200.75);
  });

  it("extracts IBAN", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(550, ["IBAN", 40]),
      makeLine(538, ["DE00110000000000000006", 40]),
      makeLine(463, ["Balance on 01/01/2021: 0.00 EUR", 40]),
      OLD_HEADER,
      makeLine(149, ["Balance on 31/01/2021: 0.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.iban).toBe("DE00110000000000000006");
  });

  it("returns warning for empty statement", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(463, ["Balance on 01/10/2020: 28.00 EUR", 40]),
      OLD_HEADER,
      makeLine(385, ["Balance on 31/10/2020: 28.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No transactions found in PDF");
  });

  it("defaults currency to EUR", () => {
    const page = makePage([SOLARIS_LINE, OLD_HEADER]);
    const result = parseNuriStatement([page]);
    expect(result.currency).toBe("EUR");
  });
});

// ─── New format parser ──────────────────────────────────────────────────────

describe("parseNuriStatement — new format", () => {
  it("parses transaction in new column layout", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(410, ["Balance on 01/11/2022: 100.00 EUR", 40]),
      NEW_HEADER,
      makeLine(350, ["SEPA Credit Transfer", 40], ["15/11/2022", 258], ["15/11/2022", 366], ["50.00", 516]),
      makeLine(338, ["from Jane Doe", 40]),
      makeLine(326, ["DE89370400440532013000", 40]),
      makeLine(270, ["Balance on 30/11/2022: 150.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2022-11-15");
    expect(result.transactions[0].description).toContain("SEPA Credit Transfer");
    expect(result.transactions[0].description).toContain("Jane Doe");
    expect(result.transactions[0].amount).toBe(50);
  });

  it("extracts balances in new format", () => {
    const page = makePage([
      SOLARIS_LINE,
      makeLine(410, ["Balance on 01/11/2022: 0.00 EUR", 40]),
      NEW_HEADER,
      makeLine(327, ["Balance on 30/11/2022: 0.00 EUR", 40]),
    ]);

    const result = parseNuriStatement([page]);

    expect(result.openingDate).toBe("2022-11-01");
    expect(result.openingBalance).toBe(0);
    expect(result.closingDate).toBe("2022-11-30");
    expect(result.closingBalance).toBe(0);
  });
});
