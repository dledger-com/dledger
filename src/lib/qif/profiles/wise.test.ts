import { describe, it, expect } from "vitest";
import { wiseQifProfile } from "./wise.js";
import { parseQif } from "../parse-qif.js";
import { convertQifToRecords } from "../convert.js";

describe("wiseQifProfile", () => {
  describe("detectFilename", () => {
    it("detects Wise QIF filename", () => {
      expect(wiseQifProfile.detectFilename!("statement_153951776_THB_2020-01-01_2026-04-17.qif")).toBe(90);
    });

    it("detects case-insensitively", () => {
      expect(wiseQifProfile.detectFilename!("Statement_153951776_EUR_2024-01-01_2024-12-31.QIF")).toBe(90);
    });

    it("rejects non-Wise filenames", () => {
      expect(wiseQifProfile.detectFilename!("export.qif")).toBe(0);
      expect(wiseQifProfile.detectFilename!("bank_statement.qif")).toBe(0);
    });
  });

  describe("extractCurrency", () => {
    it("extracts currency from Wise filename", () => {
      expect(wiseQifProfile.extractCurrency!("statement_153951776_THB_2020-01-01_2026-04-17.qif")).toBe("THB");
    });

    it("extracts EUR", () => {
      expect(wiseQifProfile.extractCurrency!("statement_123456_EUR_2024-01-01_2024-12-31.qif")).toBe("EUR");
    });

    it("returns null for non-Wise filenames", () => {
      expect(wiseQifProfile.extractCurrency!("export.qif")).toBeNull();
    });
  });

  describe("suggestAccount", () => {
    it("suggests Wise account with currency from filename", () => {
      const section = { type: "Bank" as const, transactions: [] };
      const account = wiseQifProfile.suggestAccount!(section, "statement_123_THB_2024-01-01_2024-12-31.qif");
      expect(account).toContain("Wise");
      expect(account).toContain("THB");
    });

    it("suggests generic Wise account for non-Wise filename", () => {
      const section = { type: "Bank" as const, transactions: [] };
      const account = wiseQifProfile.suggestAccount!(section, "export.qif");
      expect(account).toContain("Wise");
    });
  });

  describe("detectContent", () => {
    it("detects Wise conversion patterns", () => {
      const qif = `!Type:Bank
D03/30/2026
T4686.10
PConverted 125.00 EUR to 4,686.10 THB
MEUR-THB rate 37.7668000000000000
^`;
      const result = parseQif(qif);
      expect(wiseQifProfile.detectContent!(result)).toBeGreaterThanOrEqual(50);
    });

    it("returns 0 for generic QIF content", () => {
      const qif = `!Type:Bank
D01/15/2023
T-50.00
PGrocery Store
^`;
      const result = parseQif(qif);
      expect(wiseQifProfile.detectContent!(result)).toBe(0);
    });
  });

  describe("transformRecords", () => {
    it("transforms conversion transactions into multi-currency trades", () => {
      const qif = `!Type:Bank
D03/30/2026
T4686.10
PConverted 125.00 EUR to 4,686.10 THB
MEUR-THB rate 37.7668000000000000
^`;
      const parsed = parseQif(qif);
      const section = parsed.sections[0];

      const records = convertQifToRecords(section, {
        mainAccount: "Assets:Bank:Wise:THB",
        currency: "THB",
        rules: [],
        dateFormat: "MM/DD/YY",
      });

      const transformed = wiseQifProfile.transformRecords!(records.records, section);

      expect(transformed).toHaveLength(1);
      const rec = transformed[0];

      // Should have 4 lines: from-account, to-account, equity-from, equity-to
      expect(rec.lines).toHaveLength(4);

      // EUR side: debit from Wise EUR account
      const eurDebit = rec.lines.find((l) => l.currency === "EUR" && parseFloat(l.amount) < 0);
      expect(eurDebit).toBeDefined();
      expect(eurDebit!.account).toContain("Wise");
      expect(parseFloat(eurDebit!.amount)).toBe(-125);

      // THB side: credit to Wise THB account
      const thbCredit = rec.lines.find((l) => l.currency === "THB" && parseFloat(l.amount) > 0);
      expect(thbCredit).toBeDefined();
      expect(thbCredit!.account).toContain("Wise");
      expect(parseFloat(thbCredit!.amount)).toBe(4686.1);

      // Equity trading legs
      const equityEur = rec.lines.find((l) => l.currency === "EUR" && l.account.includes("Equity"));
      expect(equityEur).toBeDefined();
      expect(parseFloat(equityEur!.amount)).toBe(125);

      const equityThb = rec.lines.find((l) => l.currency === "THB" && l.account.includes("Equity"));
      expect(equityThb).toBeDefined();
      expect(parseFloat(equityThb!.amount)).toBe(-4686.1);
    });

    it("stores exchange rate in metadata", () => {
      const qif = `!Type:Bank
D03/30/2026
T4686.10
PConverted 125.00 EUR to 4,686.10 THB
MEUR-THB rate 37.7668000000000000
^`;
      const parsed = parseQif(qif);
      const section = parsed.sections[0];

      const records = convertQifToRecords(section, {
        mainAccount: "Assets:Bank:Wise:THB",
        currency: "THB",
        rules: [],
        dateFormat: "MM/DD/YY",
      });

      const transformed = wiseQifProfile.transformRecords!(records.records, section);

      expect(transformed[0].metadata?.["exchange-rate"]).toBe("37.7668000000000000");
      expect(transformed[0].metadata?.["exchange-from"]).toBe("EUR");
      expect(transformed[0].metadata?.["exchange-to"]).toBe("THB");
    });

    it("leaves non-conversion transactions unchanged", () => {
      const qif = `!Type:Bank
D03/15/2026
T-50.00
PGrocery Store
MWeekly shopping
^`;
      const parsed = parseQif(qif);
      const section = parsed.sections[0];

      const records = convertQifToRecords(section, {
        mainAccount: "Assets:Bank:Wise:THB",
        currency: "THB",
        rules: [],
        dateFormat: "MM/DD/YY",
      });

      const transformed = wiseQifProfile.transformRecords!(records.records, section);

      // Should remain as 2-line single-currency entry
      expect(transformed).toHaveLength(1);
      expect(transformed[0].lines).toHaveLength(2);
      expect(transformed[0].lines[0].currency).toBe("THB");
    });

    it("handles mixed conversion and regular transactions", () => {
      const qif = `!Type:Bank
D03/15/2026
T-50.00
PGrocery Store
^
D03/30/2026
T4686.10
PConverted 125.00 EUR to 4,686.10 THB
MEUR-THB rate 37.7668
^
D04/01/2026
T-200.00
PRestaurant
^`;
      const parsed = parseQif(qif);
      const section = parsed.sections[0];

      const records = convertQifToRecords(section, {
        mainAccount: "Assets:Bank:Wise:THB",
        currency: "THB",
        rules: [],
        dateFormat: "MM/DD/YY",
      });

      const transformed = wiseQifProfile.transformRecords!(records.records, section);

      expect(transformed).toHaveLength(3);
      // First: regular (2 lines)
      expect(transformed[0].lines).toHaveLength(2);
      // Second: conversion (4 lines)
      expect(transformed[1].lines).toHaveLength(4);
      // Third: regular (2 lines)
      expect(transformed[2].lines).toHaveLength(2);
    });
  });
});
