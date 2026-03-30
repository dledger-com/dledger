import { describe, it, expect } from "vitest";
import { celsiusPreset } from "./celsius.js";
import { exchangeAssetsCurrency, exchangeIncome, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const HEADERS = [
  "Internal id", "Date and time", "Transaction type", "Coin type",
  "Coin amount", "USD Value", "Original Reward Coin",
  "Reward Amount In Original Coin", "Confirmed",
];

function makeRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    "Internal id": "057ef52a-8aa4-49b3-8107-6dc11bcd74d6",
    "Date and time": "July 14, 2022 12:00 AM",
    "Transaction type": "Reward",
    "Coin type": "CEL",
    "Coin amount": "136.10650041534834",
    "USD Value": "106.031469421051691551",
    "Original Reward Coin": "AVAX",
    "Reward Amount In Original Coin": "5.641797987609493154",
    "Confirmed": "Yes",
  };
  const merged = { ...defaults, ...overrides };
  return HEADERS.map((h) => merged[h] ?? "");
}

describe("celsiusPreset", () => {
  describe("detect", () => {
    it("scores 85 for matching headers", () => {
      expect(celsiusPreset.detect(HEADERS, [])).toBe(85);
    });

    it("scores 85 for headers with leading spaces (as in real export)", () => {
      const spacedHeaders = [
        "Internal id", " Date and time", " Transaction type", " Coin type",
        " Coin amount", " USD Value", " Original Reward Coin",
        " Reward Amount In Original Coin", " Confirmed",
      ];
      expect(celsiusPreset.detect(spacedHeaders, [])).toBe(85);
    });

    it("scores 0 for non-matching headers", () => {
      expect(celsiusPreset.detect(["Date", "Amount", "Currency"], [])).toBe(0);
    });
  });

  describe("transform", () => {
    it("returns null for invalid headers", () => {
      expect(celsiusPreset.transform(["Date"], [["2024-01-15"]])).toBeNull();
    });

    it("transforms Reward with Original Reward Coin", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow()]);
      expect(records).not.toBeNull();
      expect(records).toHaveLength(1);

      const rec = records![0];
      expect(rec.date).toBe("2022-07-14");
      expect(rec.description).toBe("Celsius: Interest reward CEL");
      expect(rec.lines).toEqual([
        { account: exchangeAssetsCurrency("Celsius", "CEL"), currency: "CEL", amount: "136.10650041534834" },
        { account: exchangeIncome("Celsius", "Rewards"), currency: "CEL", amount: "-136.10650041534834" },
      ]);
      expect(rec.sourceKey).toBe("057ef52a-8aa4-49b3-8107-6dc11bcd74d6");
      expect(rec.metadata?.["original_reward_coin"]).toBe("AVAX");
      expect(rec.metadata?.["original_reward_amount"]).toBe("5.641797987609493154");
      expect(rec.metadata?.["usd_value"]).toBe("106.031469421051691551");
    });

    it("transforms Reward in native coin (no Original Reward Coin)", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow({
        "Coin type": "BTC",
        "Coin amount": "0.000946666076543084",
        "USD Value": "38.01810963397025344",
        "Original Reward Coin": "BTC",
        "Reward Amount In Original Coin": "",
      })]);
      expect(records).toHaveLength(1);

      const rec = records![0];
      expect(rec.lines[0].currency).toBe("BTC");
      expect(rec.lines[0].amount).toBe("0.000946666076543084");
    });

    it("transforms Promo Code Reward", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow({
        "Transaction type": "Promo Code Reward",
        "Coin type": "AVAX",
        "Coin amount": "31.79411151939548",
        "USD Value": "600",
        "Original Reward Coin": "",
        "Reward Amount In Original Coin": "",
      })]);
      expect(records).toHaveLength(1);

      const rec = records![0];
      expect(rec.description).toBe("Celsius: Promo reward AVAX");
      expect(rec.lines).toEqual([
        { account: exchangeAssetsCurrency("Celsius", "AVAX"), currency: "AVAX", amount: "31.79411151939548" },
        { account: exchangeIncome("Celsius", "Promo"), currency: "AVAX", amount: "-31.79411151939548" },
      ]);
    });

    it("transforms Transfer as deposit", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow({
        "Transaction type": "Transfer",
        "Coin type": "USDC",
        "Coin amount": "130002.5",
        "USD Value": "130002.5",
        "Original Reward Coin": "",
        "Reward Amount In Original Coin": "",
      })]);
      expect(records).toHaveLength(1);

      const rec = records![0];
      expect(rec.description).toBe("Celsius: Deposit USDC");
      expect(rec.lines).toEqual([
        { account: exchangeAssetsCurrency("Celsius", "USDC"), currency: "USDC", amount: "130002.5" },
        { account: EQUITY_EXTERNAL, currency: "USDC", amount: "-130002.5" },
      ]);
    });

    it("skips empty rows", () => {
      const records = celsiusPreset.transform(HEADERS, [[""]]);
      expect(records).toHaveLength(0);
    });

    it("skips rows with invalid dates", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow({ "Date and time": "bad-date" })]);
      expect(records).toHaveLength(0);
    });

    it("skips rows with zero amount", () => {
      const records = celsiusPreset.transform(HEADERS, [makeRow({ "Coin amount": "0" })]);
      expect(records).toHaveLength(0);
    });

    it("handles multiple rows", () => {
      const records = celsiusPreset.transform(HEADERS, [
        makeRow(),
        makeRow({
          "Internal id": "aaaa-bbbb",
          "Transaction type": "Transfer",
          "Coin type": "BTC",
          "Coin amount": "0.957599",
          "Original Reward Coin": "",
          "Reward Amount In Original Coin": "",
        }),
      ]);
      expect(records).toHaveLength(2);
      expect(records![0].description).toContain("Interest");
      expect(records![1].description).toContain("Deposit");
    });
  });
});
