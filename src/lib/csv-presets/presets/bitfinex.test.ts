import { describe, it, expect } from "vitest";
import { bitfinexPreset } from "./bitfinex.js";
import { exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const LEDGER_HEADERS = ["#", "DESCRIPTION", "CURRENCY", "AMOUNT", "BALANCE", "DATE", "WALLET"];

function transformLedger(rows: string[][]) {
  return bitfinexPreset.transform!(LEDGER_HEADERS, rows);
}

describe("bitfinexPreset ledger variant", () => {
  describe("exchange leg pairing by description", () => {
    it("exchange rows with same description but different timestamps get same groupKey", () => {
      const desc = "Exchange 57.35 BFX for BTC @ 0.00082 on wallet exchange";
      const records = transformLedger([
        ["1", desc, "BFX", "-57.35", "0", "2024-01-15 15:50:04", "exchange"],
        ["2", desc, "BTC", "0.047", "0.047", "2024-01-15 15:50:05", "exchange"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).toBe("2024-01-15|57.3500|BFX");
      expect(records![0].groupKey).toBe(records![1].groupKey);
    });

    it("separate fills with different descriptions get different groupKeys", () => {
      const records = transformLedger([
        ["1", "Exchange 10 ETH for BTC @ 0.05 on wallet exchange", "ETH", "-10", "0", "2024-01-15 10:30:45", "exchange"],
        ["2", "Exchange 10 ETH for BTC @ 0.05 on wallet exchange", "BTC", "0.5", "0.5", "2024-01-15 10:30:45", "exchange"],
        ["3", "Exchange 20 BTC for USD @ 40000 on wallet exchange", "BTC", "-20", "0", "2024-01-15 10:30:45", "exchange"],
        ["4", "Exchange 20 BTC for USD @ 40000 on wallet exchange", "USD", "800000", "800000", "2024-01-15 10:30:45", "exchange"],
      ]);

      expect(records).toHaveLength(4);
      // Same fill → same groupKey
      expect(records![0].groupKey).toBe(records![1].groupKey);
      expect(records![2].groupKey).toBe(records![3].groupKey);
      // Different fills → different groupKeys (no over-grouping)
      expect(records![0].groupKey).not.toBe(records![2].groupKey);
    });

    it("exchange rows produce correct line items", () => {
      const ts = "2024-01-15 10:30:45";
      const records = transformLedger([
        ["1", "Exchange 57.35 BFX for BTC @ 0.00082", "BFX", "-57.35", "0", ts, "exchange"],
        ["2", "Exchange 57.35 BFX for BTC @ 0.00082", "BTC", "0.047", "0.047", ts, "exchange"],
      ]);

      // First leg: BFX outgoing
      expect(records![0].lines).toHaveLength(2);
      expect(records![0].lines[0].account).toBe(exchangeAssetsCurrency("Bitfinex", "BFX"));
      expect(records![0].lines[0].amount).toBe("-57.35");
      expect(records![0].lines[1].account).toBe(EQUITY_TRADING);
      expect(records![0].lines[1].amount).toBe("57.35");

      // Second leg: BTC incoming
      expect(records![1].lines).toHaveLength(2);
      expect(records![1].lines[0].account).toBe(exchangeAssetsCurrency("Bitfinex", "BTC"));
      expect(records![1].lines[0].amount).toBe("0.047");
      expect(records![1].lines[1].account).toBe(EQUITY_TRADING);
      expect(records![1].lines[1].amount).toBe("-0.047");
    });

    it("exchange rows get a clean trade description", () => {
      const ts = "2024-01-15 10:30:45";
      const records = transformLedger([
        ["1", "Exchange 57.35 BFX for BTC @ 0.00082", "BFX", "-57.35", "0", ts, "exchange"],
      ]);

      expect(records![0].description).toBe("Bitfinex trade: BFX → BTC");
    });
  });

  describe("trading fee grouping with exchange legs", () => {
    it("trading fee with matching amount gets same groupKey as exchange rows", () => {
      const records = transformLedger([
        ["1", "Exchange 0.01782572 BTC for USD @ 975.72", "BTC", "-0.01782572", "0", "2017-02-09 12:00:00", "exchange"],
        ["2", "Exchange 0.01782572 BTC for USD @ 975.72", "USD", "17.39", "17.39", "2017-02-09 12:00:01", "exchange"],
        ["3", "Trading fees for 0.01782572 BTC @ 975.72", "USD", "-0.0348", "17.36", "2017-02-09 12:00:02", "exchange"],
      ]);

      expect(records).toHaveLength(3);
      // All three share the same groupKey
      expect(records![0].groupKey).toBe("2017-02-09|0.0178|BTC");
      expect(records![0].groupKey).toBe(records![1].groupKey);
      expect(records![0].groupKey).toBe(records![2].groupKey);
    });

    it("fee with rounded amount (4dp) matches exchange with full precision", () => {
      // Old data: fee description rounds to 4dp
      const records = transformLedger([
        ["1", "Exchange 0.01782572 BTC for USD @ 975.72", "BTC", "-0.01782572", "0", "2017-02-09 12:00:00", "exchange"],
        ["2", "Trading fees for 0.0178 BTC @ 975.72", "USD", "-0.0348", "17.36", "2017-02-09 12:00:02", "exchange"],
      ]);

      expect(records![0].groupKey).toBe(records![1].groupKey);
    });

    it("fee for different amount gets different groupKey", () => {
      const records = transformLedger([
        ["1", "Exchange 10 ETH for BTC @ 0.05", "ETH", "-10", "0", "2024-01-15 10:30:45", "exchange"],
        ["2", "Trading fees for 20 BTC @ 40000", "USD", "-0.05", "0", "2024-01-15 10:30:45", "exchange"],
      ]);

      expect(records![0].groupKey).not.toBe(records![1].groupKey);
    });

    it("fee records come after exchange records in output", () => {
      const records = transformLedger([
        // Fee row appears first in input
        ["3", "Trading fees for 57.35 BFX @ 0.00082", "BTC", "-0.0001", "0.0469", "2024-01-15 10:30:45", "exchange"],
        // Exchange rows after
        ["1", "Exchange 57.35 BFX for BTC @ 0.00082", "BFX", "-57.35", "0", "2024-01-15 10:30:45", "exchange"],
        ["2", "Exchange 57.35 BFX for BTC @ 0.00082", "BTC", "0.047", "0.047", "2024-01-15 10:30:45", "exchange"],
      ]);

      expect(records).toHaveLength(3);
      // Exchange records first, fee record last (regardless of input order)
      expect(records![0].description).toBe("Bitfinex trade: BFX → BTC");
      expect(records![1].description).toBe("Bitfinex trade: BFX → BTC");
      expect(records![2].description).toBe("Bitfinex fee: BTC");
    });

    it("fee row produces fee + asset lines", () => {
      const records = transformLedger([
        ["3", "Trading fees for 57.35 BFX @ 0.00082", "BTC", "-0.0001", "0.0469", "2024-01-15 10:30:45", "exchange"],
      ]);

      expect(records![0].lines).toHaveLength(2);
      expect(records![0].lines[0].account).toBe(exchangeFees("Bitfinex"));
      expect(records![0].lines[0].amount).toBe("0.0001");
      expect(records![0].lines[1].account).toBe(exchangeAssetsCurrency("Bitfinex", "BTC"));
      expect(records![0].lines[1].amount).toBe("-0.0001");
    });
  });

  describe("BFX token redemption and extraordinary loss adj grouping", () => {
    it("BFX token redemption legs get same groupKey", () => {
      const desc = "BFX token redemption of 15.0% on wallet exchange";
      const records = transformLedger([
        ["1", desc, "BFX", "-100", "0", "2017-04-03 12:00:00", "exchange"],
        ["2", desc, "USD", "15", "15", "2017-04-03 12:00:01", "exchange"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).toBe(`2017-04-03|${desc}`);
      expect(records![0].groupKey).toBe(records![1].groupKey);
    });

    it("extraordinary loss adj legs get same groupKey", () => {
      const desc = "Extraordinary loss adj of 1000.0 on wallet exchange";
      const records = transformLedger([
        ["1", desc, "USD", "-1000", "5000", "2016-08-02 18:00:00", "exchange"],
        ["2", desc, "BFX", "1000", "1000", "2016-08-02 18:00:00", "exchange"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).toBe(`2016-08-02|${desc}`);
      expect(records![0].groupKey).toBe(records![1].groupKey);
    });
  });

  describe("non-trade rows have no groupKey", () => {
    it("deposit has no groupKey", () => {
      const records = transformLedger([
        ["1", "Deposit (BITCOIN) #123 on wallet exchange", "BTC", "1.5", "1.5", "2024-01-10 08:00:00", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
    });

    it("withdrawal has no groupKey", () => {
      const records = transformLedger([
        ["1", "Withdrawal #456 on wallet exchange", "BTC", "-0.5", "1.0", "2024-01-11 09:00:00", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
    });

    it("non-trading fee has no groupKey", () => {
      const records = transformLedger([
        ["1", "Withdrawal fee on wallet exchange", "BTC", "-0.0005", "0.9995", "2024-01-11 09:00:01", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
    });
  });

  describe("deposit/withdrawal counter-account", () => {
    it("deposit uses EQUITY_EXTERNAL", () => {
      const records = transformLedger([
        ["1", "Deposit (BITCOIN) #1265542 on wallet exchange", "BTC", "1.5", "1.5", "2024-01-10 08:00:00", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
    });

    it("withdrawal uses EQUITY_EXTERNAL", () => {
      const records = transformLedger([
        ["1", "Withdrawal #456 on wallet exchange", "BTC", "-0.5", "1.0", "2024-01-11 09:00:00", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
    });

    it("exchange row uses EQUITY_TRADING", () => {
      const records = transformLedger([
        ["1", "Exchange 0.5 BTC for USD @ 40000 on wallet exchange", "BTC", "-0.5", "0", "2024-01-15 10:30:45", "exchange"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].lines[1].account).toBe(EQUITY_TRADING);
    });
  });

  describe("trades variant is unchanged", () => {
    const TRADE_HEADERS = ["#", "PAIR", "AMOUNT", "PRICE", "FEE", "FEE CURRENCY", "DATE"];

    it("produces records without groupKey", () => {
      const records = bitfinexPreset.transform!(TRADE_HEADERS, [
        ["1", "BTCUSD", "0.5", "40000", "20", "USD", "2024-01-15 10:30:45"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
    });
  });
});
