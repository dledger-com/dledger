import { describe, it, expect, beforeEach } from "vitest";
import { bankStatementPreset, setBankStatementRules } from "./bank-statement.js";

describe("bankStatementPreset", () => {
  beforeEach(() => {
    setBankStatementRules([]);
  });

  describe("detect", () => {
    it("scores 40+ for basic bank headers", () => {
      const score = bankStatementPreset.detect(
        ["Date", "Description", "Amount", "Balance"],
        [],
      );
      expect(score).toBeGreaterThanOrEqual(40);
    });

    it("scores 0 for unrelated headers", () => {
      const score = bankStatementPreset.detect(
        ["refid", "txid", "pair", "type", "ordertype"],
        [],
      );
      expect(score).toBe(0);
    });

    it("scores higher with more matches", () => {
      const basic = bankStatementPreset.detect(["Date", "Amount"], []);
      const full = bankStatementPreset.detect(
        ["Date", "Description", "Debit", "Credit", "Balance"],
        [],
      );
      expect(full).toBeGreaterThan(basic);
    });
  });

  describe("transform", () => {
    it("transforms simple bank statement", () => {
      const headers = ["Date", "Description", "Amount", "Balance"];
      const rows = [
        ["2024-01-15", "Coffee Shop", "-5.00", "995.00"],
        ["2024-01-16", "Salary Deposit", "3000.00", "3995.00"],
      ];

      const records = bankStatementPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);

      // First: expense (negative amount)
      expect(records![0].lines[0].account).toBe("Assets:Banks:Import");
      expect(parseFloat(records![0].lines[0].amount)).toBe(-5);
      expect(records![0].lines[1].account).toBe("Expenses:Uncategorized");

      // Second: income (positive amount)
      expect(records![1].lines[0].account).toBe("Assets:Banks:Import");
      expect(parseFloat(records![1].lines[0].amount)).toBe(3000);
      expect(records![1].lines[1].account).toBe("Income:Uncategorized");
    });

    it("uses categorization rules", () => {
      setBankStatementRules([
        { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
        { id: "2", pattern: "salary", account: "Income:Employment" },
      ]);

      const records = bankStatementPreset.transform(
        ["Date", "Description", "Amount"],
        [
          ["2024-01-15", "Coffee Shop", "-5.00"],
          ["2024-01-16", "Monthly Salary", "3000.00"],
        ],
      );

      expect(records![0].lines[1].account).toBe("Expenses:Coffee");
      expect(records![1].lines[1].account).toBe("Income:Employment");
    });

    it("handles debit/credit split columns", () => {
      const records = bankStatementPreset.transform(
        ["Date", "Description", "Debit", "Credit", "Balance"],
        [
          ["2024-01-15", "Coffee", "5.00", "", "995.00"],
          ["2024-01-16", "Salary", "", "3000.00", "3995.00"],
        ],
      );

      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);
      expect(parseFloat(records![0].lines[0].amount)).toBe(-5);
      expect(parseFloat(records![1].lines[0].amount)).toBe(3000);
    });

    it("handles currency column", () => {
      const records = bankStatementPreset.transform(
        ["Date", "Description", "Amount", "Currency"],
        [["2024-01-15", "Test", "100", "EUR"]],
      );

      expect(records![0].lines[0].currency).toBe("EUR");
    });

    it("returns null when no date column found", () => {
      const records = bankStatementPreset.transform(
        ["foo", "bar"],
        [["a", "b"]],
      );
      expect(records).toBeNull();
    });

    it("skips rows with invalid dates", () => {
      const records = bankStatementPreset.transform(
        ["Date", "Amount"],
        [
          ["bad-date", "100"],
          ["2024-01-15", "200"],
        ],
      );

      expect(records!).toHaveLength(1);
    });

    it("skips rows with zero amounts", () => {
      const records = bankStatementPreset.transform(
        ["Date", "Amount"],
        [["2024-01-15", "0"]],
      );
      expect(records!).toHaveLength(0);
    });
  });
});
