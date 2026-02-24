import { describe, it, expect, beforeEach } from "vitest";
import { n26Preset, setN26Rules } from "./n26.js";

describe("n26Preset", () => {
  beforeEach(() => {
    setN26Rules([]);
  });

  describe("detect", () => {
    it("scores 85 for N26 headers", () => {
      const score = n26Preset.detect(
        ["Booking Date", "Value Date", "Partner Name", "Partner Iban", "Type", "Payment Reference", "Account Name", "Amount (EUR)", "Original Amount", "Original Currency", "Exchange Rate"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      const score = n26Preset.detect(
        ["Date", "Description", "Amount"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    const headers = ["Booking Date", "Value Date", "Partner Name", "Partner Iban", "Type", "Payment Reference", "Account Name", "Amount (EUR)", "Original Amount", "Original Currency", "Exchange Rate"];

    it("transforms basic transactions", () => {
      const rows = [
        ["2026-01-31", "2026-01-30", "SARL EXEMPLE", "", "Presentment", "", "Compte courant", "-17.5", "17.5", "EUR", "1"],
        ["2026-02-03", "2026-02-03", "AMAZON PAYMENTS", "", "Presentment", "", "Compte courant", "-16.14", "16.14", "EUR", "1"],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);

      expect(records![0].date).toBe("2026-01-31");
      expect(records![0].description).toBe("SARL EXEMPLE");
      expect(records![0].lines[0].account).toBe("Assets:Bank:N26:EUR");
      expect(records![0].lines[0].currency).toBe("EUR");
      expect(records![0].lines[0].amount).toBe("-17.5");
      expect(records![0].lines[1].account).toBe("Expenses:Uncategorized");
      expect(records![0].lines[1].amount).toBe("17.5");
    });

    it("appends payment reference to description when present", () => {
      const rows = [
        ["2026-02-01", "2026-02-01", "Sophie Martin", "FR76...", "Debit Transfer", "Cours de yoga", "Compte courant", "-140.00", "", "", ""],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records![0].description).toBe("Sophie Martin — Cours de yoga");
    });

    it("does not append empty payment reference", () => {
      const rows = [
        ["2026-01-31", "2026-01-30", "SARL EXEMPLE", "", "Presentment", "", "Compte courant", "-17.5", "17.5", "EUR", "1"],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records![0].description).toBe("SARL EXEMPLE");
    });

    it("applies categorization rules", () => {
      setN26Rules([
        { id: "1", pattern: "exemple", account: "Expenses:Food" },
      ]);

      const rows = [
        ["2026-01-31", "2026-01-30", "SARL EXEMPLE", "", "Presentment", "", "Compte courant", "-17.5", "17.5", "EUR", "1"],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records![0].lines[1].account).toBe("Expenses:Food");
    });

    it("skips empty rows", () => {
      const rows = [
        ["2026-01-31", "2026-01-30", "SARL EXEMPLE", "", "Presentment", "", "Compte courant", "-17.5", "17.5", "EUR", "1"],
        [""],
        ["2026-02-03", "2026-02-03", "AMAZON PAYMENTS", "", "Presentment", "", "Compte courant", "-16.14", "16.14", "EUR", "1"],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records!).toHaveLength(2);
    });

    it("handles credit transfers (positive amounts)", () => {
      const rows = [
        ["2026-02-02", "2026-02-02", "DURAND PIERRE (EI)", "FR76...", "Credit Transfer", "LOYER MENSUEL 02/26", "Compte courant", "550.00", "", "", ""],
      ];

      const records = n26Preset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records![0].lines[0].amount).toBe("550");
      expect(records![0].lines[1].account).toBe("Income:Uncategorized");
      expect(records![0].lines[1].amount).toBe("-550");
    });

    it("extracts currency from column header", () => {
      const usdHeaders = ["Booking Date", "Value Date", "Partner Name", "Partner Iban", "Type", "Payment Reference", "Account Name", "Amount (USD)", "Original Amount", "Original Currency", "Exchange Rate"];
      const rows = [
        ["2026-01-31", "2026-01-30", "Test", "", "Presentment", "", "Account", "-10.00", "", "", ""],
      ];

      const records = n26Preset.transform(usdHeaders, rows);
      expect(records![0].lines[0].account).toBe("Assets:Bank:N26:USD");
      expect(records![0].lines[0].currency).toBe("USD");
    });

    it("returns null when required columns are missing", () => {
      const records = n26Preset.transform(
        ["Date", "Amount"],
        [["2026-01-01", "100"]],
      );
      expect(records).toBeNull();
    });
  });
});
