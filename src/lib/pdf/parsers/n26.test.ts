import { describe, it, expect } from "vitest";
import {
  parseN26Statement,
  parseN26Amount,
  parseFrenchLongDate,
  detectN26Format,
  extractN26Metadata,
} from "./n26.js";
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

// ─── New format column header ───
const NEW_HEADER = makeLine(698, ["Description", 45], ["Date de reservation", 342], ["Montant", 506]);

// ─── Amount parsing ─────────────────────────────────────────────────────────

describe("parseN26Amount", () => {
  it("parses positive amount with € suffix", () => {
    expect(parseN26Amount("+2.000,00€")).toBe(2000);
  });

  it("parses negative amount with € suffix", () => {
    expect(parseN26Amount("-1.352,09€")).toBe(-1352.09);
  });

  it("parses small positive amount", () => {
    expect(parseN26Amount("+0,50€")).toBe(0.5);
  });

  it("parses simple negative amount", () => {
    expect(parseN26Amount("-20,00€")).toBe(-20);
  });

  it("parses amount with EUR suffix", () => {
    expect(parseN26Amount("+18,31EUR")).toBe(18.31);
  });

  it("parses amount without sign (treated as positive)", () => {
    expect(parseN26Amount("100,00€")).toBe(100);
  });

  it("returns null for empty string", () => {
    expect(parseN26Amount("")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseN26Amount("abc")).toBeNull();
  });

  it("parses large amount with multiple thousands separators", () => {
    expect(parseN26Amount("+12.345.678,90€")).toBe(12345678.9);
  });
});

// ─── French long-date parsing ───────────────────────────────────────────────

describe("parseFrenchLongDate", () => {
  it("parses standard French long date", () => {
    expect(parseFrenchLongDate("vendredi, 8. septembre 2017")).toBe("2017-09-08");
  });

  it("parses single-digit day", () => {
    expect(parseFrenchLongDate("lundi, 2. octobre 2017")).toBe("2017-10-02");
  });

  it("parses double-digit day", () => {
    expect(parseFrenchLongDate("jeudi, 19. mars 2020")).toBe("2020-03-19");
  });

  it("handles février (accent)", () => {
    expect(parseFrenchLongDate("mardi, 5. février 2019")).toBe("2019-02-05");
  });

  it("handles août (accent)", () => {
    expect(parseFrenchLongDate("samedi, 12. août 2017")).toBe("2017-08-12");
  });

  it("handles décembre (accent)", () => {
    expect(parseFrenchLongDate("dimanche, 25. décembre 2018")).toBe("2018-12-25");
  });

  it("returns null for non-matching text", () => {
    expect(parseFrenchLongDate("some random text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseFrenchLongDate("")).toBeNull();
  });
});

// ─── Format detection ───────────────────────────────────────────────────────

describe("detectN26Format", () => {
  it("detects new format from column headers", () => {
    const page = makePage([NEW_HEADER]);
    expect(detectN26Format([page])).toBe("new");
  });

  it("detects old format from French long-date headers", () => {
    const page = makePage([
      makeLine(700, ["vendredi, 8. septembre 2017", 30]),
    ]);
    expect(detectN26Format([page])).toBe("old");
  });

  it("defaults to new format when neither detected", () => {
    const page = makePage([
      makeLine(700, ["Some random content", 30]),
    ]);
    expect(detectN26Format([page])).toBe("new");
  });
});

// ─── New format parser ──────────────────────────────────────────────────────

describe("parseN26Statement — new format", () => {
  it("returns warnings for empty pages", () => {
    const result = parseN26Statement([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No pages found in PDF");
  });

  it("parses basic debit transaction", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["CAFE PARIS", 44], ["15.09.2021", 391], ["-25,50€", 499]),
      makeLine(655, ["Mastercard", 44]),
    ]);
    const summary = makePage([
      makeLine(790, ["Vue d'ensemble N 09/2021", 44]),
      makeLine(676, ["Ancien solde", 44], ["+1.000,00€", 515]),
      makeLine(597, ["Votre nouveau solde", 45], ["+974,50€", 493]),
    ], 2);

    const result = parseN26Statement([page, summary]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2021-09-15");
    expect(result.transactions[0].description).toBe("CAFE PARIS");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[0].amount).toBe(-25.5);
    expect(result.transactions[0].index).toBe(0);
  });

  it("parses credit transaction", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["EMPLOYER SA", 44], ["30.09.2021", 391], ["+1.400,00€", 491]),
      makeLine(655, ["Revenus", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(1400);
  });

  it("merges multi-line descriptions and extracts metadata", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["JOHN DOE", 44], ["01.09.2021", 391], ["+550,00€", 499]),
      makeLine(655, ["Revenus", 44]),
      makeLine(640, ["IBAN: DE00100000000000000004 BIC: NTSBDEB1XXX", 44]),
      makeLine(625, ["PAYMENT REF 09/21", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("JOHN DOE");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
    expect(result.transactions[0].metadata?.iban).toBe("DE00100000000000000004");
    expect(result.transactions[0].metadata?.bic).toBe("NTSBDEB1XXX");
    expect(result.transactions[0].metadata?.reference).toBe("PAYMENT REF 09/21");
  });

  it("skips 'Date de valeur' continuation lines", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["JOHN DOE", 44], ["01.09.2021", 391], ["+550,00€", 499]),
      makeLine(655, ["Date de valeur 30.09.2021", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("JOHN DOE");
  });

  it("parses multiple transactions with metadata", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["SALARY INC", 44], ["01.09.2021", 391], ["+2.000,00€", 491]),
      makeLine(655, ["Revenus", 44]),
      makeLine(630, ["SUPERMARKET", 44], ["05.09.2021", 391], ["-85,30€", 499]),
      makeLine(615, ["Mastercard", 44]),
      makeLine(590, ["RENT PAYMENT", 44], ["10.09.2021", 391], ["-750,00€", 499]),
      makeLine(575, ["Virements sortants", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].amount).toBe(2000);
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
    expect(result.transactions[1].amount).toBe(-85.3);
    expect(result.transactions[1].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[2].amount).toBe(-750);
    expect(result.transactions[2].metadata?.["transaction-type"]).toBe("transfer-out");
  });

  it("extracts opening and closing balance from summary page", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["PAYMENT", 44], ["15.09.2021", 391], ["-50,00€", 499]),
    ]);
    const summary = makePage([
      makeLine(790, ["Vue d'ensemble N 09/2021", 44]),
      makeLine(676, ["Ancien solde", 44], ["+1.000,00€", 515]),
      makeLine(597, ["Votre nouveau solde", 45], ["+950,00€", 493]),
    ], 2);

    const result = parseN26Statement([page, summary]);

    expect(result.openingBalance).toBe(1000);
    expect(result.closingBalance).toBe(950);
  });

  it("extracts statement period dates", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
    ]);

    const result = parseN26Statement([page]);

    expect(result.openingDate).toBe("2021-09-01");
    expect(result.closingDate).toBe("2021-09-30");
  });

  it("extracts IBAN", () => {
    const page = makePage([
      makeLine(38, ["IBAN DE00100000000000000005 BIC NTSBDEB1XXX", 43]),
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
    ]);

    const result = parseN26Statement([page]);

    expect(result.iban).toBe("DE00100000000000000005");
  });

  it("returns warning for no transactions", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No transactions found in PDF");
  });

  it("defaults currency to EUR", () => {
    const result = parseN26Statement([makePage([NEW_HEADER])]);
    expect(result.currency).toBe("EUR");
  });

  it("extracts bank-category and transaction-type from description (bullet •)", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["PHARMACIE EXAMPLE Mastercard", 44], ["15.09.2021", 391], ["-25,50€", 499]),
      makeLine(655, ["• Santé et pharmacie", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("PHARMACIE EXAMPLE");
    expect(result.transactions[0].metadata?.["bank-category"]).toBe("Santé et pharmacie");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[0].metadata?.["card-type"]).toBe("mastercard");
  });

  it("extracts bank-category from description (middle dot ·)", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["CAFE PARIS Mastercard · Sorties", 44], ["15.09.2021", 391], ["-12,00€", 499]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("CAFE PARIS");
    expect(result.transactions[0].metadata?.["bank-category"]).toBe("Sorties");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
  });

  it("extracts transaction-type when no bullet in description", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["SALARY INC", 44], ["01.09.2021", 391], ["+2.000,00€", 491]),
      makeLine(655, ["Revenus", 44]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("SALARY INC");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
    expect(result.transactions[0].metadata?.["bank-category"]).toBeUndefined();
  });

  it("splits only on first bullet when multiple bullets present", () => {
    const page = makePage([
      makeLine(750, ["01.09.2021 jusqu'au 30.09.2021", 44]),
      NEW_HEADER,
      makeLine(670, ["SHOP A Mastercard • Cat A • Sub B", 44], ["15.09.2021", 391], ["-10,00€", 499]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("SHOP A");
    expect(result.transactions[0].metadata?.["bank-category"]).toBe("Cat A • Sub B");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
  });

  it("excludes page footer and header lines from transaction descriptions", () => {
    // Page 1: transaction, then footer lines at low Y
    const page1 = makePage([
      makeLine(750, ["01.01.2026 jusqu'au 31.01.2026", 44]),
      NEW_HEADER,
      makeLine(670, ["SUPERMARKET", 44], ["15.01.2026", 391], ["-42,00€", 499]),
      makeLine(655, ["Mastercard", 44]),
      // Footer lines (y ≤ 69) — name, address, IBAN
      makeLine(69, ["Jean Dupont", 44], ["Émis le 02.02.2026", 350]),
      makeLine(53, ["123 Rue Exemple, 75001 Paris", 44], ["02.02.2026", 400]),
      makeLine(37, ["IBAN FR7630001007941234567890185", 44], ["Relevé N° 01/2026", 350]),
    ], 1);

    // Page 2: header line at high Y, then more transactions
    const page2 = makePage([
      makeLine(790, ["Relevé de compte N° 01/2026", 44]),
      NEW_HEADER,
      makeLine(670, ["ONLINE SHOP", 44], ["20.01.2026", 391], ["-15,99€", 499]),
      // Footer on page 2
      makeLine(69, ["Jean Dupont", 44], ["Émis le 02.02.2026", 350]),
      makeLine(53, ["123 Rue Exemple, 75001 Paris", 44], ["02.02.2026", 400]),
    ], 2);

    const result = parseN26Statement([page1, page2]);

    expect(result.transactions).toHaveLength(2);
    // First tx should only have "SUPERMARKET", no footer content
    expect(result.transactions[0].description).toBe("SUPERMARKET");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[0].amount).toBe(-42);
    // Second tx should only have "ONLINE SHOP", no footer or header content
    expect(result.transactions[1].description).toBe("ONLINE SHOP");
    expect(result.transactions[1].amount).toBe(-15.99);

    // Verify no transaction description contains footer/header patterns
    for (const tx of result.transactions) {
      expect(tx.description).not.toMatch(/Jean Dupont/);
      expect(tx.description).not.toMatch(/Émis le/);
      expect(tx.description).not.toMatch(/IBAN FR/);
      expect(tx.description).not.toMatch(/Rue Exemple/);
      expect(tx.description).not.toMatch(/Relevé de compte/);
      expect(tx.description).not.toMatch(/Relevé N°/);
    }
  });
});

// ─── Old format parser ──────────────────────────────────────────────────────

describe("parseN26Statement — old format", () => {
  it("parses transactions grouped by French long-date", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
      makeLine(580, ["PayPal Europe", 30]),
      makeLine(565, ["Revenus", 30], ["+0,02€", 520]),
    ]);
    const summary = makePage([
      makeLine(705, ["Vue d'ensemble", 30]),
      makeLine(638, ["Ancien solde", 30], ["+18,39€", 523]),
      makeLine(539, ["Votre nouveau solde", 30], ["+18,41€", 511]),
    ], 2);

    const result = parseN26Statement([page, summary]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2017-09-08");
    expect(result.transactions[0].description).toBe("PayPal Europe");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
    expect(result.transactions[0].amount).toBe(0.02);
    expect(result.openingBalance).toBe(18.39);
    expect(result.closingBalance).toBe(18.41);
  });

  it("parses negative (debit) transaction in old format", () => {
    const page = makePage([
      makeLine(693, ["1. mars 2020 jusqu'au 31. mars 2020", 30]),
      makeLine(600, ["jeudi, 19. mars 2020", 30]),
      makeLine(580, ["ATM WITHDRAWAL", 30]),
      makeLine(565, ["Mastercard", 30], ["-400,00€", 504]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2020-03-19");
    expect(result.transactions[0].amount).toBe(-400);
  });

  it("handles multiple transactions under same date", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
      makeLine(580, ["PayPal Europe", 30]),
      makeLine(565, ["Revenus", 30], ["+0,02€", 520]),
      makeLine(540, ["Google Play", 30]),
      makeLine(525, ["Mastercard", 30], ["-2,99€", 520]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].amount).toBe(0.02);
    expect(result.transactions[1].amount).toBe(-2.99);
  });

  it("handles multiple date groups", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
      makeLine(580, ["Payment A", 30]),
      makeLine(565, ["Revenus", 30], ["+10,00€", 520]),
      makeLine(500, ["lundi, 11. septembre 2017", 30]),
      makeLine(480, ["Payment B", 30]),
      makeLine(465, ["Mastercard", 30], ["-5,00€", 520]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].date).toBe("2017-09-08");
    expect(result.transactions[1].date).toBe("2017-09-11");
  });

  it("extracts opening/closing dates from French long period", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.openingDate).toBe("2017-09-01");
    expect(result.closingDate).toBe("2017-09-30");
  });

  it("extracts IBAN in old format", () => {
    const page = makePage([
      makeLine(41, ["IBAN DE00100000000000000005 BIC NTSBDEB1XXX", 23]),
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.iban).toBe("DE00100000000000000005");
  });

  it("merges multi-line description in old format", () => {
    const page = makePage([
      makeLine(693, ["1. mars 2020 jusqu'au 31. mars 2020", 30]),
      makeLine(600, ["jeudi, 19. mars 2020", 30]),
      makeLine(580, ["PARIS SHOP", 30]),
      makeLine(565, ["Mastercard", 30]),
      makeLine(550, ["Ref: ABC123", 30], ["-50,00€", 520]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("PARIS SHOP");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[0].metadata?.reference).toBe("Ref: ABC123");
    expect(result.transactions[0].amount).toBe(-50);
  });

  it("extracts bank-category and transaction-type in old format (bullet •)", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
      makeLine(580, ["PayPal Europe", 30]),
      makeLine(565, ["Revenus • Loisirs", 30], ["+0,02€", 520]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("PayPal Europe");
    expect(result.transactions[0].metadata?.["bank-category"]).toBe("Loisirs");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
  });

  it("extracts transaction-type in old format when no bullet", () => {
    const page = makePage([
      makeLine(693, ["1. septembre 2017 jusqu'au 30. septembre 2017", 30]),
      makeLine(600, ["vendredi, 8. septembre 2017", 30]),
      makeLine(580, ["PayPal Europe", 30]),
      makeLine(565, ["Revenus", 30], ["+0,02€", 520]),
    ]);

    const result = parseN26Statement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("PayPal Europe");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("income");
    expect(result.transactions[0].metadata?.["bank-category"]).toBeUndefined();
  });

  it("excludes page footer and header lines from transaction descriptions", () => {
    const page1 = makePage([
      makeLine(693, ["1. mars 2020 jusqu'au 31. mars 2020", 30]),
      makeLine(600, ["jeudi, 19. mars 2020", 30]),
      makeLine(580, ["ATM WITHDRAWAL", 30]),
      makeLine(565, ["Mastercard", 30], ["-100,00€", 520]),
      // Footer lines
      makeLine(69, ["Jean Dupont", 30], ["Émis le 01.04.2020", 350]),
      makeLine(53, ["123 Rue Exemple, 75001 Paris", 30]),
      makeLine(37, ["IBAN FR7630001007941234567890185", 30]),
    ], 1);

    const page2 = makePage([
      // Header on page 2
      makeLine(790, ["Relevé de compte N° 03/2020", 30]),
      makeLine(600, ["vendredi, 20. mars 2020", 30]),
      makeLine(580, ["ONLINE STORE", 30]),
      makeLine(565, ["Mastercard", 30], ["-25,00€", 520]),
      makeLine(69, ["Jean Dupont", 30]),
    ], 2);

    const result = parseN26Statement([page1, page2]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].description).toBe("ATM WITHDRAWAL");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-payment");
    expect(result.transactions[1].description).toBe("ONLINE STORE");
    expect(result.transactions[1].metadata?.["transaction-type"]).toBe("card-payment");

    for (const tx of result.transactions) {
      expect(tx.description).not.toMatch(/Jean Dupont/);
      expect(tx.description).not.toMatch(/Émis le/);
      expect(tx.description).not.toMatch(/IBAN FR/);
      expect(tx.description).not.toMatch(/Relevé de compte/);
    }
  });
});

// ─── extractN26Metadata unit tests ──────────────────────────────────────────

describe("extractN26Metadata", () => {
  it("extracts card payment with category", () => {
    const { description, metadata } = extractN26Metadata("CAFE PARIS Mastercard • Bars et restaurants");
    expect(description).toBe("CAFE PARIS");
    expect(metadata["bank-category"]).toBe("Bars et restaurants");
    expect(metadata["transaction-type"]).toBe("card-payment");
    expect(metadata["card-type"]).toBe("mastercard");
  });

  it("extracts income with IBAN, BIC, and reference", () => {
    const { description, metadata } = extractN26Metadata(
      "Marie Dupont Revenus IBAN: DE00200000000000000001 • BIC: EXMPDEHHXXX Kraken Tx//ABCDE123 WXYZ 4567",
    );
    expect(description).toBe("Marie Dupont");
    expect(metadata["transaction-type"]).toBe("income");
    expect(metadata.iban).toBe("DE00200000000000000001");
    expect(metadata.bic).toBe("EXMPDEHHXXX");
    expect(metadata.reference).toBe("Kraken Tx//ABCDE123 WXYZ 4567");
    expect(metadata["bank-category"]).toBeUndefined();
  });

  it("extracts transfer-out with IBAN only (no BIC)", () => {
    const { description, metadata } = extractN26Metadata(
      "HI . G8701 Virements sortants IBAN: FR7630001007941234567890185",
    );
    expect(description).toBe("HI . G8701");
    expect(metadata["transaction-type"]).toBe("transfer-out");
    expect(metadata.iban).toBe("FR7630001007941234567890185");
    expect(metadata.bic).toBeUndefined();
  });

  it("preserves description when keyword IS the description", () => {
    const { description, metadata } = extractN26Metadata("ATM Withdrawal Fee");
    expect(description).toBe("ATM Withdrawal Fee");
    expect(metadata["transaction-type"]).toBe("atm-fee");
  });

  it("extracts instant-transfer-fee", () => {
    const { description, metadata } = extractN26Metadata(
      "Commission sur les virements instantanés",
    );
    expect(description).toBe("Commission sur les virements instantanés");
    expect(metadata["transaction-type"]).toBe("instant-transfer-fee");
  });

  it("extracts transfer-in", () => {
    const { description, metadata } = extractN26Metadata("John Doe Virements entrants");
    expect(description).toBe("John Doe");
    expect(metadata["transaction-type"]).toBe("transfer-in");
  });

  it("extracts direct-debit (Prélèvement)", () => {
    const { description, metadata } = extractN26Metadata("EDF Prélèvement SEPA");
    expect(description).toBe("EDF");
    expect(metadata["transaction-type"]).toBe("direct-debit");
  });

  it("extracts direct-debit (Prelevement without accents)", () => {
    const { description, metadata } = extractN26Metadata("EDF Prelevement");
    expect(description).toBe("EDF");
    expect(metadata["transaction-type"]).toBe("direct-debit");
  });

  it("extracts refund (Remboursement)", () => {
    const { description, metadata } = extractN26Metadata("AMAZON Remboursement");
    expect(description).toBe("AMAZON");
    expect(metadata["transaction-type"]).toBe("refund");
  });

  it("returns empty metadata when no keywords match", () => {
    const { description, metadata } = extractN26Metadata("RANDOM DESCRIPTION TEXT");
    expect(description).toBe("RANDOM DESCRIPTION TEXT");
    expect(Object.keys(metadata)).toHaveLength(0);
  });

  it("first keyword match wins (Mastercard before Revenus)", () => {
    // "Mastercard" appears before "Revenus" in keyword table
    const { description, metadata } = extractN26Metadata("SHOP Mastercard Revenus");
    expect(description).toBe("SHOP");
    expect(metadata["transaction-type"]).toBe("card-payment");
    expect(metadata["card-type"]).toBe("mastercard");
    expect(metadata.reference).toBe("Revenus");
  });

  it("extracts IBAN with spaces", () => {
    const { description, metadata } = extractN26Metadata(
      "Someone Revenus IBAN: DE00 2000 0000 0000 0000 01 BIC: EXMPDEHHXXX",
    );
    expect(metadata.iban).toBe("DE00200000000000000001");
    expect(metadata.bic).toBe("EXMPDEHHXXX");
    expect(description).toBe("Someone");
  });

  it("does not treat IBAN•BIC bullet as category separator", () => {
    const { description, metadata } = extractN26Metadata(
      "Person Revenus IBAN: DE00200000000000000001 • BIC: EXMPDEHHXXX",
    );
    expect(metadata.iban).toBe("DE00200000000000000001");
    expect(metadata.bic).toBe("EXMPDEHHXXX");
    expect(metadata["bank-category"]).toBeUndefined();
    expect(description).toBe("Person");
  });

  it("extracts reference text after keyword", () => {
    const { description, metadata } = extractN26Metadata(
      "COMPANY Virements sortants REF123 XYZ",
    );
    expect(description).toBe("COMPANY");
    expect(metadata["transaction-type"]).toBe("transfer-out");
    expect(metadata.reference).toBe("REF123 XYZ");
  });

  it("handles category with middle dot ·", () => {
    const { description, metadata } = extractN26Metadata("SHOP Mastercard · Shopping");
    expect(description).toBe("SHOP");
    expect(metadata["bank-category"]).toBe("Shopping");
    expect(metadata["transaction-type"]).toBe("card-payment");
  });
});
