import { describe, it, expect } from "vitest";
import { bybitTradePreset } from "./bybit-trade.js";

describe("bybitTradePreset", () => {
  describe("detect", () => {
    it("scores 85 for Bybit V1 headers", () => {
      const score = bybitTradePreset.detect(
        ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 85 for Bybit V2 headers", () => {
      const score = bybitTradePreset.detect(
        ["Date", "Symbol", "Side", "Avg. Price", "Qty", "Total", "Fee"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      const score = bybitTradePreset.detect(
        ["Timestamp", "Transaction Type", "Asset"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms buy trades", () => {
      const headers = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "21", "USDT"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const lines = records![0].lines;
      expect(lines.some((l) => l.account === "Assets:Bybit:BTC" && parseFloat(l.amount) === 0.5)).toBe(true);
      expect(lines.some((l) => l.account === "Assets:Bybit:USDT" && parseFloat(l.amount) === -21000)).toBe(true);
    });

    it("transforms sell trades", () => {
      const headers = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "ETHUSDT", "SELL", "2500", "2", "5000", "5", "USDT"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      const lines = records![0].lines;
      expect(lines.some((l) => l.account === "Assets:Bybit:ETH" && parseFloat(l.amount) === -2)).toBe(true);
      expect(lines.some((l) => l.account === "Assets:Bybit:USDT" && parseFloat(l.amount) === 5000)).toBe(true);
    });

    it("handles fees", () => {
      const headers = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "10.5", "USDT"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === "Expenses:Bybit:Fees")).toBe(true);
    });

    it("returns null for invalid headers", () => {
      const records = bybitTradePreset.transform(
        ["Timestamp", "Amount"],
        [["2024-01-15", "100"]],
      );
      expect(records).toBeNull();
    });

    it("skips rows with invalid dates", () => {
      const headers = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee"];
      const rows = [
        ["bad-date", "BTCUSDT", "BUY", "42000", "0.5", "21000", "0"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      expect(records!).toHaveLength(0);
    });

    it("includes Equity:Trading balancing legs", () => {
      const headers = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "0"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === "Equity:Trading")).toBe(true);
    });

    it("handles Symbol column (V2)", () => {
      const headers = ["Date", "Symbol", "Side", "Avg. Price", "Qty", "Total", "Fee"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "0"],
      ];

      const records = bybitTradePreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
    });
  });
});
