import { describe, it, expect } from "vitest";
import { BybitAdapter, bybitSign, parseBybitSymbol } from "./bybit.js";

describe("BybitAdapter", () => {
  const adapter = new BybitAdapter();

  describe("normalizeAsset", () => {
    it("passes through standard codes unchanged", () => {
      expect(adapter.normalizeAsset("BTC")).toBe("BTC");
      expect(adapter.normalizeAsset("ETH")).toBe("ETH");
      expect(adapter.normalizeAsset("USDT")).toBe("USDT");
      expect(adapter.normalizeAsset("USDC")).toBe("USDC");
      expect(adapter.normalizeAsset("SOL")).toBe("SOL");
    });
  });

  describe("bybitSign", () => {
    it("produces a hex string", async () => {
      const timestamp = "1700000000000";
      const apiKey = "test-api-key";
      const recvWindow = "5000";
      const queryString = "category=spot&limit=100";
      const secret = "test-secret-key";

      const signature = await bybitSign(timestamp, apiKey, recvWindow, queryString, secret);

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Should be a hex string (64 chars for SHA-256)
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different signatures for different inputs", async () => {
      const apiKey = "test-api-key";
      const recvWindow = "5000";
      const secret = "test-secret-key";

      const sig1 = await bybitSign("1000", apiKey, recvWindow, "category=spot", secret);
      const sig2 = await bybitSign("2000", apiKey, recvWindow, "category=spot", secret);
      const sig3 = await bybitSign("1000", apiKey, recvWindow, "category=linear", secret);

      expect(sig1).not.toBe(sig2);
      expect(sig1).not.toBe(sig3);
    });

    it("produces consistent signatures for same inputs", async () => {
      const timestamp = "1700000000000";
      const apiKey = "my-key";
      const recvWindow = "5000";
      const queryString = "category=spot&startTime=100&endTime=200";
      const secret = "my-secret";

      const sig1 = await bybitSign(timestamp, apiKey, recvWindow, queryString, secret);
      const sig2 = await bybitSign(timestamp, apiKey, recvWindow, queryString, secret);

      expect(sig1).toBe(sig2);
    });
  });

  describe("parseBybitSymbol", () => {
    it("parses BTCUSDT", () => {
      expect(parseBybitSymbol("BTCUSDT")).toEqual({ base: "BTC", quote: "USDT" });
    });

    it("parses ETHBTC", () => {
      expect(parseBybitSymbol("ETHBTC")).toEqual({ base: "ETH", quote: "BTC" });
    });

    it("parses SOLUSDC", () => {
      expect(parseBybitSymbol("SOLUSDC")).toEqual({ base: "SOL", quote: "USDC" });
    });

    it("parses ETHUSDT", () => {
      expect(parseBybitSymbol("ETHUSDT")).toEqual({ base: "ETH", quote: "USDT" });
    });

    it("parses LINKETH", () => {
      expect(parseBybitSymbol("LINKETH")).toEqual({ base: "LINK", quote: "ETH" });
    });

    it("parses BTCEUR", () => {
      expect(parseBybitSymbol("BTCEUR")).toEqual({ base: "BTC", quote: "EUR" });
    });

    it("parses ETHDAI", () => {
      expect(parseBybitSymbol("ETHDAI")).toEqual({ base: "ETH", quote: "DAI" });
    });

    it("returns null for unrecognizable symbols", () => {
      expect(parseBybitSymbol("UNKNOWN")).toBeNull();
    });

    it("returns null for a bare quote currency", () => {
      expect(parseBybitSymbol("USDT")).toBeNull();
    });
  });

  describe("exchangeId", () => {
    it("is bybit", () => {
      expect(adapter.exchangeId).toBe("bybit");
    });
  });

  describe("exchangeName", () => {
    it("is Bybit", () => {
      expect(adapter.exchangeName).toBe("Bybit");
    });
  });
});
