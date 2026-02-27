import { describe, it, expect } from "vitest";
import { coinbaseTransactionsPreset } from "./coinbase-transactions.js";
import { exchangeAssetsCurrency, exchangeFees, exchangeRewards, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

describe("coinbaseTransactionsPreset", () => {
  describe("detect", () => {
    it("scores 85 for Coinbase headers", () => {
      const score = coinbaseTransactionsPreset.detect(
        ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Spot Price at Transaction", "Subtotal", "Total (inclusive of fees and/or spread)", "Fees and/or Spread"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 85 for alternate Coinbase headers", () => {
      const score = coinbaseTransactionsPreset.detect(
        ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Subtotal", "Total", "Fees"],
        [],
      );
      expect(score).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      const score = coinbaseTransactionsPreset.detect(
        ["Date", "Description", "Amount"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms buy transactions", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Spot Price at Transaction", "Spot Price Currency", "Subtotal", "Total (inclusive of fees and/or spread)", "Fees and/or Spread"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Buy", "BTC", "0.5", "42000", "USD", "21000", "21100", "100"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Coinbase", "BTC"))).toBe(true);
    });

    it("transforms sell transactions", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Spot Price at Transaction", "Spot Price Currency", "Subtotal", "Total (inclusive of fees and/or spread)", "Fees and/or Spread"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Sell", "ETH", "2", "2500", "USD", "5000", "4950", "50"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      const lines = records![0].lines;
      expect(lines.some((l) => l.account === exchangeAssetsCurrency("Coinbase", "ETH") && parseFloat(l.amount) === -2)).toBe(true);
    });

    it("transforms send transactions", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Subtotal", "Total", "Fees"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Send", "BTC", "0.1", "", "", "0"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
      expect(records![0].lines.some((l) => l.account === exchangeAssetsCurrency("Coinbase", "BTC") && parseFloat(l.amount) === -0.1)).toBe(true);
      expect(records![0].lines.some((l) => l.account === EQUITY_EXTERNAL)).toBe(true);
    });

    it("transforms receive transactions", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Subtotal", "Total", "Fees"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Receive", "ETH", "5", "", "", "0"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
      expect(records![0].lines.some((l) => l.account === exchangeAssetsCurrency("Coinbase", "ETH") && parseFloat(l.amount) === 5)).toBe(true);
    });

    it("transforms staking rewards", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Subtotal", "Total", "Fees"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Rewards Income", "ETH", "0.01", "", "", "0"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records!).toHaveLength(1);
      expect(records![0].lines.some((l) => l.account === exchangeRewards("Coinbase"))).toBe(true);
    });

    it("handles fees", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Spot Price Currency", "Subtotal", "Total (inclusive of fees and/or spread)", "Fees and/or Spread"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Buy", "BTC", "0.5", "USD", "21000", "21100", "100"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === exchangeFees("Coinbase"))).toBe(true);
    });

    it("returns null for invalid headers", () => {
      const records = coinbaseTransactionsPreset.transform(
        ["Date", "Amount"],
        [["2024-01-15", "100"]],
      );
      expect(records).toBeNull();
    });

    it("skips rows with zero quantity", () => {
      const headers = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Subtotal", "Total", "Fees"];
      const rows = [
        ["2024-01-15T10:00:00Z", "Buy", "BTC", "0", "0", "0", "0"],
      ];

      const records = coinbaseTransactionsPreset.transform(headers, rows);
      expect(records!).toHaveLength(0);
    });
  });
});
