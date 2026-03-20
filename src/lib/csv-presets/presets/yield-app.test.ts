import { describe, it, expect } from "vitest";
import { yieldAppPreset } from "./yield-app.js";
import { exchangeAssetsCurrency, exchangeIncome } from "$lib/accounts/paths.js";

const HEADERS = ["Date", "Amount", "Currency", "Type", "Status", "Rewarded From", "Fund Price", "YLD Price"];

function makeRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    Date: "15-01-2024 10:00:00 UTC",
    Amount: "100",
    Currency: "YLD",
    Type: "interest",
    Status: "Succeeded",
    "Rewarded From": "",
    "Fund Price": "",
    "YLD Price": "",
  };
  const merged = { ...defaults, ...overrides };
  return HEADERS.map((h) => merged[h] ?? "");
}

describe("yieldAppPreset", () => {
  describe("transform — income types", () => {
    it("routes interest to Income:Interest", () => {
      const records = yieldAppPreset.transform(HEADERS, [makeRow({ Type: "interest" })]);
      expect(records).toHaveLength(1);
      expect(records![0].lines).toEqual([
        { account: exchangeAssetsCurrency("YieldApp", "YLD"), currency: "YLD", amount: "100" },
        { account: exchangeIncome("YieldApp", "Interest"), currency: "YLD", amount: "-100" },
      ]);
      expect(records![0].description).toBe("Yield App interest reward: YLD");
    });

    it("routes referral reward to Income:Referral", () => {
      const records = yieldAppPreset.transform(HEADERS, [makeRow({ Type: "referral reward" })]);
      expect(records).toHaveLength(1);
      expect(records![0].lines[1].account).toBe(exchangeIncome("YieldApp", "Referral"));
      expect(records![0].description).toBe("Yield App referral reward: YLD");
    });

    it("routes bonus to Income:Bonus", () => {
      const records = yieldAppPreset.transform(HEADERS, [makeRow({ Type: "bonus" })]);
      expect(records).toHaveLength(1);
      expect(records![0].lines).toEqual([
        { account: exchangeAssetsCurrency("YieldApp", "YLD"), currency: "YLD", amount: "100" },
        { account: exchangeIncome("YieldApp", "Bonus"), currency: "YLD", amount: "-100" },
      ]);
      expect(records![0].description).toBe("Yield App bonus reward: YLD");
    });

    it("routes reward to Income:Rewards", () => {
      const records = yieldAppPreset.transform(HEADERS, [makeRow({ Type: "reward" })]);
      expect(records).toHaveLength(1);
      expect(records![0].lines).toEqual([
        { account: exchangeAssetsCurrency("YieldApp", "YLD"), currency: "YLD", amount: "100" },
        { account: exchangeIncome("YieldApp", "Rewards"), currency: "YLD", amount: "-100" },
      ]);
      expect(records![0].description).toBe("Yield App general reward: YLD");
    });
  });
});
