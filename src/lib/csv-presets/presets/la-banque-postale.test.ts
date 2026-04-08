import { describe, it, expect, beforeEach } from "vitest";
import { laBanquePostalePreset, setLaBanquePostaleRules } from "./la-banque-postale.js";

describe("laBanquePostalePreset", () => {
  beforeEach(() => {
    setLaBanquePostaleRules([]);
  });

  describe("detect", () => {
    it("scores 85 for metadata-preamble headers with matching data rows", () => {
      const score = laBanquePostalePreset.detect(
        ["Numéro Compte   ", "1234567X020"],
        [
          ["Type         ", "CCP"],
          ["Compte tenu en  ", "euros"],
          ["Date            ", "24/02/2026"],
          ["Solde (EUROS)   ", "707,39"],
          [""],
          ["Date", "Libellé", "Montant(EUROS)"],
          ["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"],
        ],
      );
      expect(score).toBe(85);
    });

    it("scores 85 for direct headers with Libellé and Montant", () => {
      const score = laBanquePostalePreset.detect(
        ["Date", "Libellé", "Montant(EUROS)"],
        [["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"]],
      );
      expect(score).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      const score = laBanquePostalePreset.detect(
        ["Transaction ID", "Symbol", "Side", "Price", "Qty"],
        [["12345", "BTCUSD", "BUY", "50000", "0.1"]],
      );
      expect(score).toBe(0);
    });

    it("scores 0 for metadata preamble without real header row in data", () => {
      const score = laBanquePostalePreset.detect(
        ["Numéro Compte   ", "1234567X020"],
        [
          ["Type         ", "CCP"],
          ["some random data", "no headers here"],
        ],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform with preamble", () => {
    const metadataHeaders = ["Numéro Compte   ", "1234567X020"];
    const rows = [
      ["Type         ", "CCP"],
      ["Compte tenu en  ", "euros"],
      ["Date            ", "24/02/2026"],
      ["Solde (EUROS)   ", "707,39"],
      [""],
      ["Date", "Libellé", "Montant(EUROS)"],
      ["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"],
      ["14/02/2026", "VIREMENT EN VOTRE FAVEUR", "5000,00"],
    ];

    it("parses transactions from metadata-preamble format", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);
    });

    it("uses Libellé column values as description", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows)!;
      expect(records[0].description).toBe("La Banque Postale: PRELEVEMENT DE EXAMPLE TELCO");
      expect(records[1].description).toBe("La Banque Postale: VIREMENT EN VOTRE FAVEUR");
    });

    it("parses DD/MM/YYYY dates correctly", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows)!;
      expect(records[0].date).toBe("2026-02-16");
      expect(records[1].date).toBe("2026-02-14");
    });

    it("parses European amounts correctly", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows)!;
      expect(records[0].lines[0].amount).toBe("-24.99");
      expect(records[1].lines[0].amount).toBe("5000");
    });

    it("uses EUR currency and LaBanquePostale account from preamble", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows)!;
      expect(records[0].lines[0].account).toBe("Assets:Bank:LaBanquePostale:CCP");
      expect(records[0].lines[0].currency).toBe("EUR");
    });

    it("assigns counter-accounts based on sign", () => {
      const records = laBanquePostalePreset.transform(metadataHeaders, rows)!;
      // Negative amount → Expenses
      expect(records[0].lines[1].account).toBe("Expenses:Uncategorized");
      // Positive amount → Income
      expect(records[1].lines[1].account).toBe("Income:Uncategorized");
    });
  });

  describe("transform direct", () => {
    it("parses transactions when headers are provided directly", () => {
      const headers = ["Date", "Libellé", "Montant(EUROS)"];
      const rows = [
        ["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"],
        ["14/02/2026", "VIREMENT EN VOTRE FAVEUR", "5000,00"],
      ];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);
      expect(records![0].date).toBe("2026-02-16");
      expect(records![0].lines[0].amount).toBe("-24.99");
      expect(records![1].lines[0].amount).toBe("5000");
    });
  });

  describe("categorization rules", () => {
    it("applies categorization rules to descriptions", () => {
      setLaBanquePostaleRules([
        { id: "1", pattern: "example telco", account: "Expenses:Telecom" },
      ]);

      const headers = ["Date", "Libellé", "Montant(EUROS)"];
      const rows = [["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"]];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records![0].lines[1].account).toBe("Expenses:Telecom");
    });
  });

  describe("parseFileHeader", () => {
    const metadataHeaders = ["Numéro Compte   ", "1234567X020"];
    const preambleRows = [
      ["Type         ", "CCP"],
      ["Compte tenu en  ", "euros"],
      ["Date            ", "24/02/2026"],
      ["Solde (EUROS)   ", "707,39"],
      [""],
      ["Date", "Libellé", "Montant(EUROS)"],
      ["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"],
    ];

    it("extracts all fields from full preamble", () => {
      const result = laBanquePostalePreset.parseFileHeader!(metadataHeaders, preambleRows);
      expect(result).not.toBeNull();
      expect(result!.accountMetadata).toEqual({ accountID: "1234567X020" });
      expect(result!.mainAccount).toBe("Assets:Bank:LaBanquePostale:CCP");
      expect(result!.balanceDate).toBe("2026-02-24");
      expect(result!.balanceAmount).toBe("707.39");
      expect(result!.balanceCurrency).toBe("EUR");
    });

    it("returns null for direct headers (no preamble)", () => {
      const result = laBanquePostalePreset.parseFileHeader!(
        ["Date", "Libellé", "Montant(EUROS)"],
        [["16/02/2026", "PRELEVEMENT", "-24,99"]],
      );
      expect(result).toBeNull();
    });

    it("returns partial result when Solde line is missing", () => {
      const partialRows = [
        ["Type         ", "CCP"],
        ["Compte tenu en  ", "euros"],
        ["Date            ", "24/02/2026"],
        [""],
        ["Date", "Libellé", "Montant(EUROS)"],
        ["16/02/2026", "PRELEVEMENT", "-24,99"],
      ];
      const result = laBanquePostalePreset.parseFileHeader!(metadataHeaders, partialRows);
      expect(result).not.toBeNull();
      expect(result!.accountMetadata).toEqual({ accountID: "1234567X020" });
      expect(result!.mainAccount).toBe("Assets:Bank:LaBanquePostale:CCP");
      expect(result!.balanceDate).toBe("2026-02-24");
      expect(result!.balanceAmount).toBeUndefined();
      expect(result!.balanceCurrency).toBe("EUR");
    });
  });

  describe("edge cases", () => {
    it("returns null when required columns are missing", () => {
      const records = laBanquePostalePreset.transform(
        ["Foo", "Bar"],
        [["a", "b"]],
      );
      expect(records).toBeNull();
    });

    it("skips empty rows", () => {
      const headers = ["Date", "Libellé", "Montant(EUROS)"];
      const rows = [
        ["16/02/2026", "PRELEVEMENT", "-24,99"],
        [""],
        ["14/02/2026", "VIREMENT", "100,00"],
      ];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records!).toHaveLength(2);
    });

    it("skips rows with zero amount", () => {
      const headers = ["Date", "Libellé", "Montant(EUROS)"];
      const rows = [
        ["16/02/2026", "PRELEVEMENT", "0,00"],
        ["14/02/2026", "VIREMENT", "100,00"],
      ];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
    });

    it("uses default description for empty libellé", () => {
      const headers = ["Date", "Libellé", "Montant(EUROS)"];
      const rows = [["16/02/2026", "", "-24,99"]];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records![0].description).toBe("La Banque Postale: La Banque Postale transaction");
    });

    it("falls back to libell prefix when é is mangled by encoding", () => {
      // Simulates the column header after UTF-8 misread of ISO-8859-1
      const headers = ["Date", "Libell\uFFFD", "Montant(EUROS)"];
      const rows = [["16/02/2026", "PRELEVEMENT DE EXAMPLE TELCO", "-24,99"]];

      const records = laBanquePostalePreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records![0].description).toBe("La Banque Postale: PRELEVEMENT DE EXAMPLE TELCO");
    });
  });
});
