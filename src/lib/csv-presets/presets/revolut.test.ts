import { describe, it, expect, beforeEach } from "vitest";
import { revolutPreset, setRevolutRules } from "./revolut.js";

describe("revolutPreset", () => {
  beforeEach(() => {
    setRevolutRules([]);
  });

  describe("detect", () => {
    it("scores 80 for Revolut headers", () => {
      const score = revolutPreset.detect(
        ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "Balance", "State"],
        [],
      );
      expect(score).toBe(80);
    });

    it("scores 0 for unrelated headers", () => {
      const score = revolutPreset.detect(
        ["Date", "Description", "Amount"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms basic Revolut transactions", () => {
      const headers = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "Balance", "State"];
      const rows = [
        ["CARD_PAYMENT", "Current", "2024-01-15", "2024-01-15", "Coffee Shop", "-5.00", "0", "EUR", "995.00", "COMPLETED"],
        ["TOPUP", "Current", "2024-01-14", "2024-01-14", "Salary", "3000.00", "0", "EUR", "1000.00", "COMPLETED"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);

      expect(records![0].lines[0].account).toBe("Assets:Revolut:EUR");
      expect(records![0].lines[0].currency).toBe("EUR");
    });

    it("filters out non-COMPLETED transactions", () => {
      const headers = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "Balance", "State"];
      const rows = [
        ["CARD_PAYMENT", "Current", "2024-01-15", "2024-01-15", "Coffee", "-5.00", "0", "EUR", "995.00", "COMPLETED"],
        ["CARD_PAYMENT", "Current", "2024-01-16", "2024-01-16", "Declined", "-50.00", "0", "EUR", "995.00", "DECLINED"],
        ["CARD_PAYMENT", "Current", "2024-01-17", "", "Pending", "-10.00", "0", "EUR", "985.00", "PENDING"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
    });

    it("handles fees", () => {
      const headers = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "Balance", "State"];
      const rows = [
        ["EXCHANGE", "Current", "2024-01-15", "2024-01-15", "FX Exchange", "-100.00", "-0.50", "EUR", "900.00", "COMPLETED"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === "Expenses:Revolut:Fees")).toBe(true);
    });

    it("uses categorization rules", () => {
      setRevolutRules([
        { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
      ]);

      const headers = ["Type", "Product", "Completed Date", "Description", "Amount", "Currency", "State"];
      const rows = [
        ["CARD_PAYMENT", "Current", "2024-01-15", "Coffee Shop", "-5.00", "EUR", "COMPLETED"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records![0].lines[1].account).toBe("Expenses:Coffee");
    });

    it("uses Completed Date over Started Date", () => {
      const headers = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Currency", "State"];
      const rows = [
        ["CARD_PAYMENT", "Current", "2024-01-14", "2024-01-15", "Test", "-5.00", "EUR", "COMPLETED"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records![0].date).toBe("2024-01-15");
    });

    it("returns null when no date column found", () => {
      const records = revolutPreset.transform(
        ["Type", "Amount"],
        [["PAYMENT", "100"]],
      );
      expect(records).toBeNull();
    });

    it("handles multiple currencies", () => {
      const headers = ["Type", "Product", "Completed Date", "Description", "Amount", "Currency", "State"];
      const rows = [
        ["TOPUP", "Current", "2024-01-15", "Deposit", "100.00", "USD", "COMPLETED"],
        ["TOPUP", "Current", "2024-01-16", "Deposit", "200.00", "GBP", "COMPLETED"],
      ];

      const records = revolutPreset.transform(headers, rows);
      expect(records![0].lines[0].account).toBe("Assets:Revolut:USD");
      expect(records![1].lines[0].account).toBe("Assets:Revolut:GBP");
    });
  });
});
