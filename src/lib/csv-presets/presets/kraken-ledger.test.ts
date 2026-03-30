import { describe, it, expect } from "vitest";
import { krakenLedgerPreset } from "./kraken-ledger.js";
import { exchangeAssetsCurrency, exchangeFees, exchangeStaking } from "$lib/accounts/paths.js";

describe("krakenLedgerPreset", () => {
  describe("detect", () => {
    it("scores 90 for exact Kraken headers", () => {
      const score = krakenLedgerPreset.detect(
        ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"],
        [],
      );
      expect(score).toBe(90);
    });

    it("scores 0 for non-Kraken headers", () => {
      const score = krakenLedgerPreset.detect(
        ["Date", "Description", "Amount"],
        [],
      );
      expect(score).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms deposits", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "deposit", "", "currency", "XXBT", "1.5", "0", "1.5"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!.length).toBeGreaterThanOrEqual(1);

      const deposit = records!.find((r) => r.description.includes("Deposit"));
      expect(deposit).toBeDefined();
      expect(deposit!.lines[0].account).toBe(exchangeAssetsCurrency("Kraken", "BTC"));
      expect(deposit!.lines[0].currency).toBe("BTC");
    });

    it("transforms trades with grouping by refid", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "trade-1", "2024-01-15 10:00:00", "trade", "", "currency", "XXBT", "-0.5", "0", "1.0"],
        ["tx2", "trade-1", "2024-01-15 10:00:00", "trade", "", "currency", "ZUSD", "25000", "5.00", "25000"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();

      const tradeRecords = records!.filter((r) => r.description.includes("Trade"));
      expect(tradeRecords.length).toBeGreaterThanOrEqual(1);

      // Should have BTC and USD legs
      const allLines = tradeRecords.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.currency === "BTC")).toBe(true);
      expect(allLines.some((l) => l.currency === "USD")).toBe(true);
    });

    it("normalizes Kraken asset codes", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "deposit", "", "currency", "XETH", "10", "0", "10"],
        ["tx2", "ref2", "2024-01-15 10:00:00", "deposit", "", "currency", "ZEUR", "1000", "0", "1000"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!.some((r) => r.lines[0].currency === "ETH")).toBe(true);
      expect(records!.some((r) => r.lines[0].currency === "EUR")).toBe(true);
    });

    it("handles fees", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "deposit", "", "currency", "ZUSD", "1000", "2.50", "997.50"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      const allLines = records!.flatMap((r) => r.lines);
      expect(allLines.some((l) => l.account === exchangeFees("Kraken"))).toBe(true);
    });

    it("handles staking rewards", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "staking", "", "currency", "DOT", "0.5", "0", "10.5"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      expect(records!.length).toBeGreaterThanOrEqual(1);
      const staking = records![0];
      expect(staking.lines.some((l) => l.account === exchangeStaking("Kraken"))).toBe(true);
    });

    it("handles withdrawals", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "withdrawal", "", "currency", "XXBT", "-0.5", "0.0001", "0.5"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records).not.toBeNull();
      const wd = records!.find((r) => r.description.includes("Withdrawal"));
      expect(wd).toBeDefined();
      expect(wd!.lines[0].account).toBe(exchangeAssetsCurrency("Kraken", "BTC"));
    });

    it("returns null for invalid headers", () => {
      const records = krakenLedgerPreset.transform(
        ["Date", "Amount"],
        [["2024-01-15", "100"]],
      );
      expect(records).toBeNull();
    });

    it("skips rows with invalid dates", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "bad-date", "deposit", "", "currency", "XXBT", "1.5", "0", "1.5"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips rows with invalid amounts", () => {
      const headers = ["txid", "refid", "time", "type", "subtype", "aclass", "asset", "amount", "fee", "balance"];
      const rows = [
        ["tx1", "ref1", "2024-01-15 10:00:00", "deposit", "", "currency", "XXBT", "abc", "0", "0"],
      ];

      const records = krakenLedgerPreset.transform(headers, rows);
      expect(records!).toHaveLength(0);
    });
  });
});
