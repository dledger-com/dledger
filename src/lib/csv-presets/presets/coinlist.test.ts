import { describe, it, expect } from "vitest";
import { coinlistPreset } from "./coinlist.js";
import { exchangeAssetsCurrency, exchangeStaking, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const HEADERS = ["Date", "Description", "Asset", "Amount", "Balance"];

function transform(rows: string[][]) {
  return coinlistPreset.transform!(HEADERS, rows);
}

describe("coinlistPreset", () => {
  describe("trade groupKey", () => {
    it("two sold rows with same date/description get same groupKey", () => {
      const records = transform([
        ["December 18, 2021 14:30:00 UTC", "Sold 1333.333333 HMT for 0.02122666 BTC", "HMT", "-1333.33", "0"],
        ["December 18, 2021 14:30:00 UTC", "Sold 1333.333333 HMT for 0.02122666 BTC", "BTC", "0.02122666", "0.02122666"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).toBeDefined();
      expect(records![0].groupKey).toBe(records![1].groupKey);
      // Each leg has asset + EQUITY_TRADING lines
      expect(records![0].lines).toHaveLength(2);
      expect(records![0].lines[0].account).toBe(exchangeAssetsCurrency("CoinList", "HMT"));
      expect(records![0].lines[1].account).toBe(EQUITY_TRADING);
      expect(records![1].lines[0].account).toBe(exchangeAssetsCurrency("CoinList", "BTC"));
      expect(records![1].lines[1].account).toBe(EQUITY_TRADING);
    });

    it("two bought rows with same date/description get same groupKey", () => {
      const records = transform([
        ["January 5, 2022 10:00:00 UTC", "Bought 500 ALGO for 0.5 BTC", "BTC", "-0.5", "0"],
        ["January 5, 2022 10:00:00 UTC", "Bought 500 ALGO for 0.5 BTC", "ALGO", "500", "500"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).toBeDefined();
      expect(records![0].groupKey).toBe(records![1].groupKey);
    });

    it("trade rows with different descriptions get different groupKeys", () => {
      const records = transform([
        ["December 18, 2021 14:30:00 UTC", "Sold 100 HMT for 0.001 BTC", "HMT", "-100", "0"],
        ["December 18, 2021 14:30:00 UTC", "Sold 200 HMT for 0.002 BTC", "HMT", "-200", "0"],
      ]);

      expect(records).toHaveLength(2);
      expect(records![0].groupKey).not.toBe(records![1].groupKey);
    });
  });

  describe("non-trade rows have no groupKey", () => {
    it("staking reward has no groupKey", () => {
      const records = transform([
        ["March 1, 2022 08:00:00 UTC", "Staking Reward", "ALGO", "1.5", "501.5"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
      expect(records![0].lines[0].account).toBe(exchangeAssetsCurrency("CoinList", "ALGO"));
      expect(records![0].lines[1].account).toBe(exchangeStaking("CoinList"));
    });

    it("deposit has no groupKey", () => {
      const records = transform([
        ["February 10, 2022 12:00:00 UTC", "BTC Deposit", "BTC", "0.1", "0.1"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
    });

    it("withdrawal has no groupKey", () => {
      const records = transform([
        ["February 15, 2022 12:00:00 UTC", "BTC Withdrawal", "BTC", "-0.05", "0.05"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].groupKey).toBeUndefined();
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
    });
  });
});
