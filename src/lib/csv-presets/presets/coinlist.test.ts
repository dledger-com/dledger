import { describe, it, expect } from "vitest";
import { coinlistPreset } from "./coinlist.js";
import { exchangeAssetsCurrency, exchangeFees, exchangeStaking, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

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

  describe("harmonized descriptions", () => {
    it("staking reward uses renderDescription format", () => {
      const records = transform([
        ["March 1, 2022 08:00:00 UTC", "Staking Reward", "ALGO", "1.5", "501.5"],
      ]);

      expect(records![0].description).toBe("CoinList staking reward: ALGO");
      expect(records![0].descriptionData).toEqual({
        type: "cex-reward", exchange: "CoinList", kind: "staking", currency: "ALGO",
      });
    });

    it("trade uses renderDescription format with both currencies", () => {
      const records = transform([
        ["December 18, 2021 14:30:00 UTC", "Sold 8.216919 MINA for 6.47 USDC", "MINA", "-8.216919", "0"],
      ]);

      expect(records![0].description).toBe("CoinList trade: MINA → USDC");
      expect(records![0].descriptionData).toEqual({
        type: "cex-trade", exchange: "CoinList", spent: "MINA", received: "USDC",
      });
    });

    it("bought trade extracts both currencies correctly", () => {
      const records = transform([
        ["January 5, 2022 10:00:00 UTC", "Bought 500 ALGO for 0.5 BTC", "ALGO", "500", "500"],
      ]);

      expect(records![0].description).toBe("CoinList trade: BTC → ALGO");
      expect(records![0].descriptionData).toEqual({
        type: "cex-trade", exchange: "CoinList", spent: "BTC", received: "ALGO",
      });
    });

    it("deposit uses renderDescription format", () => {
      const records = transform([
        ["February 10, 2022 12:00:00 UTC", "Deposit of 1,854.258221 USDC", "USDC", "1854.258221", "1854.258221"],
      ]);

      expect(records![0].description).toBe("CoinList deposit: USDC");
    });

    it("withdrawal uses renderDescription format", () => {
      const records = transform([
        ["February 15, 2022 12:00:00 UTC", "Withdrawal of 100 BTC to 0xabc", "BTC", "-100", "0"],
      ]);

      expect(records![0].description).toBe("CoinList withdrawal: BTC");
    });

    it("distribution uses operation format", () => {
      const records = transform([
        ["March 5, 2022 10:00:00 UTC", "Distribution of HMT", "HMT", "50", "50"],
      ]);

      expect(records![0].description).toBe("CoinList distribution: HMT");
    });
  });

  describe("withdrawal fee extraction", () => {
    it("extracts fee from withdrawal description with bullet separator", () => {
      const records = transform([
        ["February 15, 2022 12:00:00 UTC", "Withdrawal of 945.15 USDC to 0xabc• Fee 54.85 USDC", "USDC", "-1000", "0"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].lines).toHaveLength(3);

      // Asset account: -1000
      expect(records![0].lines[0].account).toBe(exchangeAssetsCurrency("CoinList", "USDC"));
      expect(records![0].lines[0].amount).toBe("-1000");

      // External: +945.15
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
      expect(parseFloat(records![0].lines[1].amount)).toBeCloseTo(945.15, 2);

      // Fee: +54.85
      expect(records![0].lines[2].account).toBe(exchangeFees("CoinList"));
      expect(parseFloat(records![0].lines[2].amount)).toBeCloseTo(54.85, 2);
    });

    it("falls back to 2-line pattern when no fee in description", () => {
      const records = transform([
        ["February 15, 2022 12:00:00 UTC", "BTC Withdrawal", "BTC", "-0.05", "0.05"],
      ]);

      expect(records).toHaveLength(1);
      expect(records![0].lines).toHaveLength(2);
      expect(records![0].lines[0].account).toBe(exchangeAssetsCurrency("CoinList", "BTC"));
      expect(records![0].lines[1].account).toBe(EQUITY_EXTERNAL);
    });
  });
});
