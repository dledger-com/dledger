import { describe, it, expect } from "vitest";
import { bisqPreset } from "./bisq.js";
import { exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const TRADE_HEADERS = [
  "Trade ID", "Date/Time", "Market", "Price", "Amount in BTC",
  "Amount", "Currency", "Offer type", "Status", "Trade Fee BTC",
];

const TX_HEADERS = ["Date/Time", "Details", "Transaction ID", "Amount in BTC"];

describe("bisqPreset", () => {
  describe("detect", () => {
    it("scores 85 for trade headers", () => {
      expect(bisqPreset.detect(TRADE_HEADERS, [])).toBe(85);
    });

    it("scores 85 for transaction headers", () => {
      expect(bisqPreset.detect(TX_HEADERS, [])).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      expect(bisqPreset.detect(["Date", "Amount"], [])).toBe(0);
    });
  });

  describe("transform — trades", () => {
    it("parses named-month dates", () => {
      const rows = [
        ["T1", "May 5, 2020 4:47:08 PM", "BTC/EUR", "8000", "0.5", "4000", "EUR", "Buy BTC", "Completed", "0.001"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].date).toBe("2020-05-05");
    });

    it("parses ISO dates (rotki-exported format)", () => {
      const rows = [
        ["T2", "2020-05-05 16:47:08", "BTC/EUR", "8000", "0.5", "4000", "EUR", "Buy BTC", "Completed", "0.001"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].date).toBe("2020-05-05");
    });

    it("generates correct trade lines for a buy", () => {
      const rows = [
        ["T1", "2024-01-15 10:00:00", "BTC/EUR", "42000", "0.5", "21000", "EUR", "Buy BTC", "Completed", "0.002"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      expect(records).toHaveLength(1);
      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Bisq", "BTC") && parseFloat(l.amount) === 0.5)).toBe(true);
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Bisq", "EUR") && parseFloat(l.amount) === -21000)).toBe(true);
      expect(lines.some((l) => l.account === EQUITY_TRADING)).toBe(true);
    });

    it("generates fee lines", () => {
      const rows = [
        ["T1", "2024-01-15 10:00:00", "BTC/EUR", "42000", "0.5", "21000", "EUR", "Buy BTC", "Completed", "0.005"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === exchangeFees("Bisq") && l.currency === "BTC")).toBe(true);
    });

    it("skips canceled trades", () => {
      const rows = [
        ["T1", "2024-01-15 10:00:00", "BTC/EUR", "42000", "0.5", "21000", "EUR", "Buy BTC", "Canceled", "0"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      expect(records).toHaveLength(0);
    });

    it("handles sell trades", () => {
      const rows = [
        ["T1", "2024-01-15 10:00:00", "BTC/EUR", "42000", "0.5", "21000", "EUR", "Sell BTC", "Completed", "0"],
      ];
      const records = bisqPreset.transform(TRADE_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].description).toContain("Trade");
    });
  });

  describe("transform — transactions", () => {
    it("parses named-month dates", () => {
      const rows = [
        ["Jan 10, 2023 12:00:00 PM", "Deposit", "txid123", "0.1"],
      ];
      const records = bisqPreset.transform(TX_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].date).toBe("2023-01-10");
    });

    it("parses ISO dates", () => {
      const rows = [
        ["2023-01-10 12:00:00", "Deposit", "txid123", "0.1"],
      ];
      const records = bisqPreset.transform(TX_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].date).toBe("2023-01-10");
    });

    it("creates deposit records for positive amounts", () => {
      const rows = [
        ["2023-01-10 12:00:00", "Deposit", "txid123", "0.5"],
      ];
      const records = bisqPreset.transform(TX_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].description).toContain("Deposit");
      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Bisq", "BTC"))).toBe(true);
      expect(lines.some((l) => l.account === EQUITY_EXTERNAL)).toBe(true);
    });

    it("creates withdrawal records for negative amounts", () => {
      const rows = [
        ["2023-01-10 12:00:00", "Withdrawal", "txid456", "-0.3"],
      ];
      const records = bisqPreset.transform(TX_HEADERS, rows);
      expect(records).toHaveLength(1);
      expect(records![0].description).toContain("Withdrawal");
    });

    it("skips rows with zero amount", () => {
      const rows = [
        ["2023-01-10 12:00:00", "Something", "txid789", "0"],
      ];
      const records = bisqPreset.transform(TX_HEADERS, rows);
      expect(records).toHaveLength(0);
    });
  });
});
