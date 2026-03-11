import { describe, it, expect } from "vitest";
import {
  parseLbpStatement,
  detectColumns,
  parseLbpAmount,
  resolveYear,
  extractLbpMetadata,
} from "./la-banque-postale.js";
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

/** Build a minimal LBP-style page with header + transactions (2022 format). */
function make2022Page(
  lines: PdfTextLine[],
  pageNumber = 1,
): PdfPage {
  return { pageNumber, lines };
}

/** Standard 2022-format table header */
const HEADER_2022 = makeLine(319, ["Date", 54], ["Opérations", 86], ["Débit (¤)", 433], ["Crédit (¤)", 506]);

/** Standard 2012-format table header (with Soit en francs) */
const HEADER_2012 = makeLine(309, ["Date", 54], ["Opérations", 86], ["Débit (¤)", 355], ["Crédit (¤)", 423], ["Soit en francs", 496]);

describe("detectColumns", () => {
  it("detects 2022 format columns", () => {
    const cols = detectColumns(HEADER_2022);
    expect(cols).not.toBeNull();
    expect(cols!.debitX).toBe(433);
    expect(cols!.creditX).toBe(506);
  });

  it("detects 2012 format columns", () => {
    const cols = detectColumns(HEADER_2012);
    expect(cols).not.toBeNull();
    expect(cols!.debitX).toBe(355);
    expect(cols!.creditX).toBe(423);
  });

  it("returns null for non-header lines", () => {
    const line = makeLine(100, ["Some", 10], ["text", 50]);
    expect(detectColumns(line)).toBeNull();
  });

  it("returns null if Date is missing", () => {
    const line = makeLine(100, ["Opérations", 86], ["Débit (¤)", 433], ["Crédit (¤)", 506]);
    expect(detectColumns(line)).toBeNull();
  });
});

describe("parseLbpAmount", () => {
  it("parses simple amount", () => {
    expect(parseLbpAmount("2,20")).toBe(2.2);
  });

  it("parses amount with space thousands separator", () => {
    expect(parseLbpAmount("1 203,55")).toBe(1203.55);
  });

  it("parses integer amount", () => {
    expect(parseLbpAmount("750,00")).toBe(750);
  });

  it("parses large amount", () => {
    expect(parseLbpAmount("20 089,30")).toBe(20089.3);
  });

  it("returns null for empty string", () => {
    expect(parseLbpAmount("")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseLbpAmount("abc")).toBeNull();
  });
});

describe("resolveYear", () => {
  it("uses closing year when both years match", () => {
    expect(resolveYear(3, 2022, 2022, "2022-01-26", "2022-02-25")).toBe(2022);
  });

  it("uses opening year for high months at year boundary", () => {
    expect(resolveYear(12, 2021, 2022, "2021-12-01", "2022-01-01")).toBe(2021);
  });

  it("uses closing year for low months at year boundary", () => {
    expect(resolveYear(1, 2021, 2022, "2021-12-01", "2022-01-01")).toBe(2022);
  });

  it("uses closing year if only closing available", () => {
    expect(resolveYear(5, null, 2022, null, "2022-06-30")).toBe(2022);
  });

  it("uses opening year if only opening available", () => {
    expect(resolveYear(5, 2022, null, "2022-04-01", null)).toBe(2022);
  });
});

describe("parseLbpStatement", () => {
  it("returns warnings for empty pages", () => {
    const result = parseLbpStatement([]);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No pages found in PDF");
  });

  it("parses basic debit transaction", () => {
    const page = make2022Page([
      makeLine(394, ["Compte Courant Postal", 54], ["n° 12 345 67X 000", 201]),
      makeLine(382, ["IBAN : FR0020041000010000000X000001 | BIC : PSSTFRPPPAR", 54]),
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["522,92", 506]),
      makeLine(282, ["31/01", 54], ["ACHAT CB TOLLOPERATOR EXAMPLE 28.01.22", 86], ["2,20", 446]),
      makeLine(273, ["CARTE NUMERO 999", 86]),
      makeLine(646, ["Total des opérations", 306], ["2,20", 433], ["0,00", 506]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["520,72", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2022-01-31");
    expect(result.transactions[0].description).toBe("TOLLOPERATOR EXAMPLE");
    expect(result.transactions[0].amount).toBe(-2.2);
    expect(result.transactions[0].index).toBe(0);
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("card-purchase");
    expect(result.transactions[0].metadata?.["card-number"]).toBe("336");
    expect(result.transactions[0].metadata?.["operation-date"]).toBe("28/01");
  });

  it("parses credit transaction", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(221, ["02/02", 54], ["VIREMENT DE MLLE JANE DOE", 86], ["750,00", 511]),
      makeLine(211, ["loyer loyer REFERENCE : 0000000000000001", 86]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["850,00", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(750);
    expect(result.transactions[0].description).toContain("MLLE JANE DOE");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("transfer-in");
    expect(result.transactions[0].metadata?.["reference"]).toBe("0000000000000001");
  });

  it("classifies debit vs credit by column position", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      // Debit at x=446 (near debitX=433)
      makeLine(282, ["31/01", 54], ["Expense", 86], ["50,00", 446]),
      // Credit at x=511 (near creditX=506)
      makeLine(262, ["02/02", 54], ["Income", 86], ["200,00", 511]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["250,00", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].amount).toBe(-50); // debit = negative
    expect(result.transactions[1].amount).toBe(200); // credit = positive
  });

  it("merges multi-line descriptions", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(189, ["04/02", 54], ["PRELEVEMENT DE EXAMPLECARRIER", 86], ["21,99", 441]),
      makeLine(179, ["REF : 00000000A EXAMPLECARRIER", 86]),
      makeLine(169, ["MANDAT : XXXX-00000", 86]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["78,01", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("EXAMPLECARRIER EXAMPLECARRIER");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("direct-debit");
    expect(result.transactions[0].metadata?.["reference"]).toBe("00000000A");
    expect(result.transactions[0].metadata?.["mandate"]).toBe("XXXX-00000");
  });

  it("extracts opening and closing balance", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["522,92", 506]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["631,60", 508]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.openingBalance).toBe(522.92);
    expect(result.openingDate).toBe("2022-01-26");
    expect(result.closingBalance).toBe(631.6);
    expect(result.closingDate).toBe("2022-02-25");
  });

  it("infers year from opening/closing balance dates", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(282, ["31/01", 54], ["Transaction in January", 86], ["10,00", 446]),
      makeLine(262, ["15/02", 54], ["Transaction in February", 86], ["20,00", 446]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["70,00", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions[0].date).toBe("2022-01-31");
    expect(result.transactions[1].date).toBe("2022-02-15");
  });

  it("handles year boundary (Dec → Jan)", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 30/11/2021", 272], ["100,00", 506]),
      makeLine(282, ["15/12", 54], ["December tx", 86], ["10,00", 446]),
      makeLine(262, ["05/01", 54], ["January tx", 86], ["20,00", 446]),
      makeLine(623, ["Nouveau solde au 31/01/2022", 264], ["70,00", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].date).toBe("2021-12-15");
    expect(result.transactions[1].date).toBe("2022-01-05");
  });

  it("skips Total des opérations line", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(282, ["31/01", 54], ["An expense", 86], ["50,00", 446]),
      makeLine(655, ["Total des opérations", 306], ["50,00", 425], ["0,00", 509]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["50,00", 509]),
    ]);

    const result = parseLbpStatement([page]);
    // Only the actual transaction, not the total line
    expect(result.transactions).toHaveLength(1);
  });

  it("handles multi-page with (suite) continuation", () => {
    const page1 = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(282, ["31/01", 54], ["First tx", 86], ["10,00", 446]),
    ], 1);

    const continuationHeader = makeLine(684, ["Date", 54], ["Opérations", 86], ["Débit (¤)", 433], ["Crédit (¤)", 506]);
    const page2 = make2022Page([
      makeLine(706, ["Vos opérations CCP n° 12 345 67X 000 (suite)", 54]),
      continuationHeader,
      makeLine(670, ["15/02", 54], ["Second tx", 86], ["20,00", 446]),
      makeLine(655, ["Total des opérations", 306], ["30,00", 425], ["0,00", 509]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["70,00", 509]),
    ], 2);

    const result = parseLbpStatement([page1, page2]);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].description).toBe("First tx");
    expect(result.transactions[1].description).toBe("Second tx");
  });

  it("handles 2012 format with Soit en francs column", () => {
    const page = make2022Page([
      makeLine(401, ["Compte Courant Postal", 54], ["n° 12 345 67X 000", 201]),
      makeLine(389, ["IBAN : FR0020041000010000000X000001 | BIC : PSSTFRPPPAR", 54]),
      HEADER_2012,
      makeLine(290, ["Ancien solde au 24/08/2012", 197], ["445,75", 422]),
      // Debit at x=362 (near debitX=355), plus francs value at x=513
      makeLine(252, ["30/08", 54], ["ACHAT CB INSURANCE-VAD 29.08.12", 86], ["24,27", 362], ["-159,18", 513]),
      makeLine(243, ["CARTE NUMERO 888", 86]),
      makeLine(623, ["Nouveau solde au 26/09/2012", 264], ["421,48", 422]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(-24.27);
    expect(result.transactions[0].date).toBe("2012-08-30");
    expect(result.transactions[0].description).not.toContain("-159,18");
    // extractLbpMetadata strips "ACHAT CB", date "29.08.12", and "CARTE NUMERO 888"
    expect(result.transactions[0].description).toBe("INSURANCE-VAD");
  });

  it("excludes francs column values from credit transaction descriptions", () => {
    const page = make2022Page([
      makeLine(401, ["Compte Courant Postal", 54], ["n° 12 345 67X 000", 201]),
      HEADER_2012,
      makeLine(290, ["Ancien solde au 24/08/2012", 197], ["445,75", 422]),
      // Credit at x=430 (near creditX=423), plus francs value at x=510
      makeLine(252, ["15/09", 54], ["VIR SEPA SALAIRE", 86], ["76,22", 430], ["+ 499,64", 510]),
      makeLine(623, ["Nouveau solde au 26/09/2012", 264], ["521,97", 422]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(76.22);
    expect(result.transactions[0].description).not.toContain("499,64");
  });

  it("skips francs values on continuation lines", () => {
    const page = make2022Page([
      makeLine(401, ["Compte Courant Postal", 54], ["n° 12 345 67X 000", 201]),
      HEADER_2012,
      makeLine(290, ["Ancien solde au 24/08/2012", 197], ["445,75", 422]),
      makeLine(252, ["30/08", 54], ["ACHAT CB INSURANCE-VAD 29.08.12", 86], ["24,27", 362], ["-159,18", 513]),
      // Continuation line with a francs-column value
      makeLine(243, ["CARTE NUMERO 888", 86], ["-159,18", 513]),
      makeLine(623, ["Nouveau solde au 26/09/2012", 264], ["421,48", 422]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    // extractLbpMetadata strips "ACHAT CB", date, and card number — francs value must not leak
    expect(result.transactions[0].description).toBe("INSURANCE-VAD");
    expect(result.transactions[0].description).not.toContain("-159,18");
  });

  it("extracts account number", () => {
    const page = make2022Page([
      makeLine(394, ["Compte Courant Postal", 54], ["n° 12 345 67X 000", 201]),
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["100,00", 506]),
    ]);

    const result = parseLbpStatement([page]);
    expect(result.accountNumber).toBe("12 345 67X 000");
  });

  it("extracts IBAN", () => {
    const page = make2022Page([
      makeLine(382, ["IBAN : FR00 2004 1000 0100 0000 0X00 001 | BIC : PSSTFRPPPAR", 54]),
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["100,00", 506]),
    ]);

    const result = parseLbpStatement([page]);
    expect(result.iban).toBe("FR0020041000010000000X000001");
  });

  it("returns warning for no table found", () => {
    const page = make2022Page([
      makeLine(100, ["Just some random text", 50]),
    ]);

    const result = parseLbpStatement([page]);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings).toContain("No transaction table found in PDF");
  });

  it("handles empty transaction table (no actual transactions)", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["100,00", 506]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["100,00", 506]),
    ]);

    const result = parseLbpStatement([page]);
    expect(result.transactions).toHaveLength(0);
    expect(result.openingBalance).toBe(100);
    expect(result.closingBalance).toBe(100);
  });

  it("parses European amount with thousands separator", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["1 000,00", 506]),
      makeLine(282, ["02/02", 54], ["Big transfer", 86], ["2 500,00", 511]),
      makeLine(655, ["Total des opérations", 306], ["0,00", 425], ["2 500,00", 509]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["3 500,00", 508]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(2500);
    expect(result.openingBalance).toBe(1000);
    expect(result.closingBalance).toBe(3500);
  });

  it("parses ATM withdrawal with CARTE X prefix on date line and RETRAIT DAB on continuation", () => {
    const page = make2022Page([
      HEADER_2022,
      makeLine(300, ["Ancien solde au 26/01/2022", 272], ["500,00", 506]),
      makeLine(282, ["15/02", 54], ["CARTE X2843 A 09H27", 86], ["60,00", 446]),
      makeLine(273, ["RETRAIT DAB LA BANQUE POSTALE", 86]),
      makeLine(623, ["Nouveau solde au 25/02/2022", 264], ["440,00", 506]),
    ]);

    const result = parseLbpStatement([page]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2022-02-15");
    expect(result.transactions[0].amount).toBe(-60);
    expect(result.transactions[0].description).toBe("LA BANQUE POSTALE");
    expect(result.transactions[0].metadata?.["transaction-type"]).toBe("atm-withdrawal");
    expect(result.transactions[0].metadata?.["card-number"]).toBe("2843");
    expect(result.transactions[0].metadata?.["operation-time"]).toBe("09:27");
  });

  it("defaults currency to EUR", () => {
    const result = parseLbpStatement([make2022Page([HEADER_2022])]);
    expect(result.currency).toBe("EUR");
  });
});

describe("extractLbpMetadata", () => {
  it("extracts ACHAT CB with merchant, date, and card number", () => {
    const result = extractLbpMetadata("ACHAT CB TOLLOPERATOR EXAMPLE 28.01.22 CARTE NUMERO 999");
    expect(result.description).toBe("TOLLOPERATOR EXAMPLE");
    expect(result.metadata["transaction-type"]).toBe("card-purchase");
    expect(result.metadata["card-number"]).toBe("336");
    expect(result.metadata["operation-date"]).toBe("28/01");
  });

  it("extracts ACHAT CB with CB*XXXX format", () => {
    const result = extractLbpMetadata("ACHAT CB SUPERMARCHE 15.03 CB*4567");
    expect(result.description).toBe("SUPERMARCHE");
    expect(result.metadata["transaction-type"]).toBe("card-purchase");
    expect(result.metadata["card-number"]).toBe("4567");
    expect(result.metadata["operation-date"]).toBe("15/03");
  });

  it("extracts VIREMENT DE with REFERENCE", () => {
    const result = extractLbpMetadata("VIREMENT DE MLLE JANE DOE loyer loyer REFERENCE : 0000000000000001");
    expect(result.description).toBe("MLLE JANE DOE loyer loyer");
    expect(result.metadata["transaction-type"]).toBe("transfer-in");
    expect(result.metadata["reference"]).toBe("0000000000000001");
  });

  it("VIREMENT EN FAVEUR DE must not match as VIREMENT DE", () => {
    const result = extractLbpMetadata("VIREMENT EN FAVEUR DE JOHN DOE");
    expect(result.metadata["transaction-type"]).toBe("transfer-out");
    expect(result.description).toBe("JOHN DOE");
  });

  it("extracts VIREMENT POUR as transfer-out", () => {
    const result = extractLbpMetadata("VIREMENT POUR LOYER MARS");
    expect(result.metadata["transaction-type"]).toBe("transfer-out");
    expect(result.description).toBe("LOYER MARS");
  });

  it("extracts CHEQUE N° with number", () => {
    const result = extractLbpMetadata("CHEQUE N° 2676038");
    expect(result.metadata["transaction-type"]).toBe("check");
    expect(result.metadata["check-number"]).toBe("2676038");
  });

  it("extracts PRELEVEMENT DE with REF + MANDAT", () => {
    const result = extractLbpMetadata("PRELEVEMENT DE EXAMPLECARRIER REF : 00000000A EXAMPLECARRIER MANDAT : XXXX-00000");
    expect(result.description).toBe("EXAMPLECARRIER EXAMPLECARRIER");
    expect(result.metadata["transaction-type"]).toBe("direct-debit");
    expect(result.metadata["reference"]).toBe("00000000A");
    expect(result.metadata["mandate"]).toBe("XXXX-00000");
  });

  it("extracts INTERETS ACQUIS", () => {
    const result = extractLbpMetadata("INTERETS ACQUIS AU 31/12/2022");
    expect(result.metadata["transaction-type"]).toBe("interest");
    expect(result.metadata["operation-date"]).toBe("31/12");
  });

  it("extracts RETRAIT DAB with location + date", () => {
    const result = extractLbpMetadata("RETRAIT DAB ANNECY 15/02");
    expect(result.description).toBe("ANNECY");
    expect(result.metadata["transaction-type"]).toBe("atm-withdrawal");
    expect(result.metadata["operation-date"]).toBe("15/02");
  });

  it("maps FRAIS to fee", () => {
    const result = extractLbpMetadata("FRAIS DE TENUE DE COMPTE");
    expect(result.metadata["transaction-type"]).toBe("fee");
    expect(result.description).toBe("DE TENUE DE COMPTE");
  });

  it("maps COMMISSION to fee", () => {
    const result = extractLbpMetadata("COMMISSION D'INTERVENTION");
    expect(result.metadata["transaction-type"]).toBe("fee");
    expect(result.description).toBe("D'INTERVENTION");
  });

  it("maps COTISATION to fee", () => {
    const result = extractLbpMetadata("COTISATION TRIMESTRIELLE");
    expect(result.metadata["transaction-type"]).toBe("fee");
    expect(result.description).toBe("TRIMESTRIELLE");
  });

  it("extracts REMISE CHEQUE distinct from CHEQUE", () => {
    const result = extractLbpMetadata("REMISE CHEQUE 3 CHEQUES");
    expect(result.metadata["transaction-type"]).toBe("check-deposit");
    expect(result.description).toBe("3 CHEQUES");
  });

  it("maps AVOIR to refund", () => {
    const result = extractLbpMetadata("AVOIR REMBOURSEMENT ACHAT");
    expect(result.metadata["transaction-type"]).toBe("refund");
    expect(result.description).toBe("REMBOURSEMENT ACHAT");
  });

  it("strips CARTE X prefix with embedded date and extracts ATM withdrawal metadata", () => {
    const result = extractLbpMetadata("CARTE X2843 02/12/16 A 09H27 RETRAIT DAB LA BANQUE POSTALE");
    expect(result.metadata["transaction-type"]).toBe("atm-withdrawal");
    expect(result.metadata["card-number"]).toBe("2843");
    expect(result.metadata["operation-time"]).toBe("09:27");
    expect(result.metadata["operation-date"]).toBe("02/12");
    expect(result.description).toBe("LA BANQUE POSTALE");
  });

  it("strips CARTE X prefix without date (backward compat)", () => {
    const result = extractLbpMetadata("CARTE X2843 A 09H27 RETRAIT DAB LA BANQUE POSTALE");
    expect(result.metadata["transaction-type"]).toBe("atm-withdrawal");
    expect(result.metadata["card-number"]).toBe("2843");
    expect(result.metadata["operation-time"]).toBe("09:27");
    expect(result.description).toBe("LA BANQUE POSTALE");
  });

  it("extracts VIREMENT PERMANENT POUR as standing-order", () => {
    const result = extractLbpMetadata("VIREMENT PERMANENT POUR M. DUPONT");
    expect(result.metadata["transaction-type"]).toBe("standing-order");
    expect(result.description).toBe("M. DUPONT");
  });

  it("extracts VIREMENT PERMANENT DE as standing-order", () => {
    const result = extractLbpMetadata("VIREMENT PERMANENT DE MME MARTIN");
    expect(result.metadata["transaction-type"]).toBe("standing-order");
    expect(result.description).toBe("MME MARTIN");
  });

  it("returns empty metadata and unchanged description for no match", () => {
    const result = extractLbpMetadata("Some unknown description");
    expect(result.description).toBe("Some unknown description");
    expect(Object.keys(result.metadata)).toHaveLength(0);
  });

  it("keeps original description if empty after stripping", () => {
    const result = extractLbpMetadata("CHEQUE N° 1234");
    expect(result.metadata["transaction-type"]).toBe("check");
    expect(result.metadata["check-number"]).toBe("1234");
    // After stripping "CHEQUE " prefix and "N° 1234", body is empty → keep original
    expect(result.description).toBe("CHEQUE N° 1234");
  });
});
