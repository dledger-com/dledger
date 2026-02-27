import { describe, it, expect } from "vitest";
import { binanceTradePreset } from "./binance-trade.js";
import { exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING } from "$lib/accounts/paths.js";

describe("binanceTradePreset", () => {
  describe("detect", () => {
    it("scores 85 for Binance headers", () => {
      const score = binanceTradePreset.detect(
        ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 85 for alternate Binance headers", () => {
      const score = binanceTradePreset.detect(
        ["Date(UTC)", "Market", "Side", "Price", "Amount", "Total", "Fee", "Fee Coin"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      const score = binanceTradePreset.detect(
        ["Date", "Description", "Amount"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms buy trades", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "21", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Binance", "BTC") && parseFloat(l.amount) === 0.5)).toBe(true);
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Binance", "USDT") && parseFloat(l.amount) === -21000)).toBe(true);
    });

    it("transforms sell trades", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "ETHUSDT", "SELL", "2500", "2", "5000", "5", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Binance", "ETH") && parseFloat(l.amount) === -2)).toBe(true);
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Binance", "USDT") && parseFloat(l.amount) === 5000)).toBe(true);
    });

    it("handles fees", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "10.5", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === exchangeFees("Binance"))).toBe(true);
    });

    it("handles slash-separated pairs", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTC/USDT", "BUY", "42000", "0.5", "21000", "0", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
    });

    it("returns null for invalid headers", () => {
      const records = binanceTradePreset.transform(
        ["Date", "Amount"],
        [["2024-01-15", "100"]],
      );
      expect(records).toBeNull();
    });

    it("skips rows with invalid dates", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["bad-date", "BTCUSDT", "BUY", "42000", "0.5", "21000", "0", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      expect(records!).toHaveLength(0);
    });

    it("includes Equity:Trading balancing legs", () => {
      const headers = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
      const rows = [
        ["2024-01-15 10:00:00", "BTCUSDT", "BUY", "42000", "0.5", "21000", "0", "USDT"],
      ];

      const records = binanceTradePreset.transform(headers, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === EQUITY_TRADING)).toBe(true);
    });
  });
});
