import { describe, it, expect } from "vitest";
import { poloniexPreset } from "./poloniex.js";
import { exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const TRADE_HEADERS = ["Date", "Market", "Category", "Type", "Price", "Amount", "Total", "Fee", "Order Number", "Base Total Less Fee", "Quote Total Less Fee", "Fee Currency", "Fee Total"];
const DEPOSIT_HEADERS = ["depositNumber", "currency", "address", "amount", "txid", "timestamp", "status", "depositType"];
const WITHDRAWAL_HEADERS = ["withdrawalRequestsId", "currency", "address", "amount", "fee", "timestamp", "status", "paymentID"];

describe("poloniexPreset", () => {
  describe("detect", () => {
    it("scores 85 for trade headers", () => {
      expect(poloniexPreset.detect(TRADE_HEADERS, [])).toBe(85);
    });

    it("scores 90 for deposit headers", () => {
      expect(poloniexPreset.detect(DEPOSIT_HEADERS, [])).toBe(90);
    });

    it("scores 90 for withdrawal headers", () => {
      expect(poloniexPreset.detect(WITHDRAWAL_HEADERS, [])).toBe(90);
    });

    it("scores 0 for unrelated headers", () => {
      expect(poloniexPreset.detect(["Date", "Amount", "Description"], [])).toBe(0);
    });
  });

  describe("transform deposits", () => {
    it("transforms a completed deposit", () => {
      const rows = [
        ["12345678", "ETH", "0xabc123", "1.50000000", "0xdef456", "2019-04-21 08:29:38", "COMPLETED", "deposit"],
      ];

      const records = poloniexPreset.transform(DEPOSIT_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2019-04-21");
      expect(r.description).toBe("Poloniex deposit: ETH");
      expect(r.sourceKey).toBe("12345678");

      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Poloniex", "ETH") && parseFloat(l.amount) === 1.5)).toBe(true);
      expect(r.lines.some((l) => l.account === EQUITY_EXTERNAL && parseFloat(l.amount) === -1.5)).toBe(true);
    });

    it("sets sourceKey to depositNumber", () => {
      const rows = [
        ["99887766", "BTC", "1abc", "0.10000000", "txhash", "2020-01-15 12:00:00", "COMPLETED", "deposit"],
      ];

      const records = poloniexPreset.transform(DEPOSIT_HEADERS, rows);
      expect(records![0].sourceKey).toBe("99887766");
    });

    it("skips non-COMPLETED deposits", () => {
      const rows = [
        ["12345678", "ETH", "0xabc", "1.50000000", "0xdef", "2019-04-21 08:29:38", "PENDING", "deposit"],
      ];

      const records = poloniexPreset.transform(DEPOSIT_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips rows with zero amount", () => {
      const rows = [
        ["12345678", "ETH", "0xabc", "0", "0xdef", "2019-04-21 08:29:38", "COMPLETED", "deposit"],
      ];

      const records = poloniexPreset.transform(DEPOSIT_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips rows with invalid date", () => {
      const rows = [
        ["12345678", "ETH", "0xabc", "1.5", "0xdef", "invalid-date", "COMPLETED", "deposit"],
      ];

      const records = poloniexPreset.transform(DEPOSIT_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });
  });

  describe("transform withdrawals", () => {
    it("transforms a completed withdrawal", () => {
      const rows = [
        ["87654321", "BTC", "1BitcoinAddress", "0.05000000", "0.00050000", "2019-06-15 14:22:10", "COMPLETED", ""],
      ];

      const records = poloniexPreset.transform(WITHDRAWAL_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2019-06-15");
      expect(r.description).toBe("Poloniex withdrawal: BTC");
      expect(r.sourceKey).toBe("87654321");

      // Withdrawal amount is negative
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Poloniex", "BTC") && parseFloat(l.amount) === -0.05)).toBe(true);
    });

    it("sets sourceKey to withdrawalRequestsId", () => {
      const rows = [
        ["55443322", "USDT", "TAddr", "100.00000000", "1.00000000", "2021-03-01 10:00:00", "COMPLETED", ""],
      ];

      const records = poloniexPreset.transform(WITHDRAWAL_HEADERS, rows);
      expect(records![0].sourceKey).toBe("55443322");
    });

    it("includes fee lines when fee > 0", () => {
      const rows = [
        ["87654321", "BTC", "1addr", "0.05000000", "0.00050000", "2019-06-15 14:22:10", "COMPLETED", ""],
      ];

      const records = poloniexPreset.transform(WITHDRAWAL_HEADERS, rows);
      const allLines = records![0].lines;
      expect(allLines.some((l) => l.account === exchangeFees("Poloniex") && parseFloat(l.amount) === 0.0005)).toBe(true);
    });

    it("omits fee lines when fee is 0", () => {
      const rows = [
        ["87654321", "ETH", "0xaddr", "1.00000000", "0.00000000", "2020-01-01 00:00:00", "COMPLETED", ""],
      ];

      const records = poloniexPreset.transform(WITHDRAWAL_HEADERS, rows);
      const allLines = records![0].lines;
      expect(allLines.every((l) => l.account !== exchangeFees("Poloniex"))).toBe(true);
    });

    it("skips non-COMPLETED withdrawals", () => {
      const rows = [
        ["87654321", "BTC", "1addr", "0.05000000", "0.00050000", "2019-06-15 14:22:10", "AWAITING APPROVAL", ""],
      ];

      const records = poloniexPreset.transform(WITHDRAWAL_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });
  });

  describe("transform trades", () => {
    it("transforms a buy trade", () => {
      const rows = [
        ["2019-04-21 08:00:00", "ETH/BTC", "Exchange", "Buy", "0.02750000", "10.00000000", "0.27500000", "0.25%", "123456", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2019-04-21");
      expect(r.description).toBe("Poloniex trade: BTC → ETH");

      // Buy: receive base (ETH), spend quote (BTC)
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Poloniex", "ETH") && parseFloat(l.amount) === 10)).toBe(true);
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Poloniex", "BTC") && parseFloat(l.amount) === -0.275)).toBe(true);
      expect(r.lines.some((l) => l.account === EQUITY_TRADING)).toBe(true);
    });

    it("transforms a sell trade", () => {
      const rows = [
        ["2019-05-10 12:30:00", "ETH/USDT", "Exchange", "Sell", "250.00000000", "5.00000000", "1250.00000000", "0.15%", "789012", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.description).toBe("Poloniex trade: ETH → USDT");
    });

    it("applies percentage fee on buy (fee on base)", () => {
      const rows = [
        ["2019-04-21 08:00:00", "ETH/BTC", "Exchange", "Buy", "0.02750000", "10.00000000", "0.27500000", "0.25%", "123456", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      const allLines = records![0].lines;
      // Fee = 10 * 0.0025 = 0.025 ETH
      expect(allLines.some((l) => l.account === exchangeFees("Poloniex") && l.currency === "ETH" && Math.abs(parseFloat(l.amount) - 0.025) < 1e-9)).toBe(true);
    });

    it("applies percentage fee on sell (fee on quote)", () => {
      const rows = [
        ["2019-05-10 12:30:00", "ETH/USDT", "Exchange", "Sell", "250.00000000", "5.00000000", "1250.00000000", "0.15%", "789012", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      const allLines = records![0].lines;
      // Fee = 1250 * 0.0015 = 1.875 USDT
      expect(allLines.some((l) => l.account === exchangeFees("Poloniex") && l.currency === "USDT" && Math.abs(parseFloat(l.amount) - 1.875) < 1e-9)).toBe(true);
    });

    it("skips rows with zero amount", () => {
      const rows = [
        ["2019-04-21 08:00:00", "ETH/BTC", "Exchange", "Buy", "0.02750000", "0", "0", "0.25%", "123456", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips rows with invalid date", () => {
      const rows = [
        ["not-a-date", "ETH/BTC", "Exchange", "Buy", "0.02750000", "10", "0.275", "0.25%", "123456", "", "", "", ""],
      ];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips empty rows", () => {
      const rows = [[""]];

      const records = poloniexPreset.transform(TRADE_HEADERS, rows);
      expect(records!).toHaveLength(0);
    });
  });
});
