import { describe, it, expect } from "vitest";
import { CryptocomAdapter, cryptocomSign, buildParamString } from "./cryptocom.js";

describe("CryptocomAdapter", () => {
  const adapter = new CryptocomAdapter();

  describe("normalizeAsset", () => {
    it("passes through standard codes as identity", () => {
      expect(adapter.normalizeAsset("BTC")).toBe("BTC");
      expect(adapter.normalizeAsset("ETH")).toBe("ETH");
      expect(adapter.normalizeAsset("USDT")).toBe("USDT");
      expect(adapter.normalizeAsset("CRO")).toBe("CRO");
    });

    it("passes through unknown codes as identity", () => {
      expect(adapter.normalizeAsset("UNKNOWN123")).toBe("UNKNOWN123");
    });
  });

  describe("cryptocomSign", () => {
    it("produces a hex string of 64 characters", async () => {
      const method = "private/get-trades";
      const id = 1234567890;
      const apiKey = "test-api-key";
      const params = { page_size: 100, page: 0 };
      const nonce = 1234567890;
      const secret = "test-secret-key-for-hmac-testing";

      const signature = await cryptocomSign(method, id, apiKey, params, nonce, secret);

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Hex characters only
      expect(signature).toMatch(/^[0-9a-f]+$/);
      // HMAC-SHA256 produces 64 hex chars
      expect(signature).toHaveLength(64);
    });

    it("produces different signatures for different inputs", async () => {
      const secret = "test-secret-key-for-hmac-testing";
      const apiKey = "test-api-key";
      const params = { page_size: 100, page: 0 };

      const sig1 = await cryptocomSign("private/get-trades", 1000, apiKey, params, 1000, secret);
      const sig2 = await cryptocomSign("private/get-deposit-history", 2000, apiKey, params, 2000, secret);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different secrets", async () => {
      const method = "private/get-trades";
      const id = 1000;
      const apiKey = "test-api-key";
      const params = { page_size: 100, page: 0 };
      const nonce = 1000;

      const sig1 = await cryptocomSign(method, id, apiKey, params, nonce, "secret-one");
      const sig2 = await cryptocomSign(method, id, apiKey, params, nonce, "secret-two");

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("buildParamString", () => {
    it("sorts keys alphabetically and concatenates", () => {
      expect(buildParamString({ b: 2, a: 1 })).toBe("a1b2");
    });

    it("handles page params correctly", () => {
      expect(buildParamString({ page: 0, page_size: 100 })).toBe("page0page_size100");
    });

    it("returns empty string for empty params", () => {
      expect(buildParamString({})).toBe("");
    });

    it("handles string values", () => {
      expect(buildParamString({ currency: "BTC", status: "1" })).toBe("currencyBTCstatus1");
    });
  });

  describe("exchangeId", () => {
    it("is cryptocom", () => {
      expect(adapter.exchangeId).toBe("cryptocom");
    });
  });

  describe("exchangeName", () => {
    it("is Crypto.com", () => {
      expect(adapter.exchangeName).toBe("Crypto.com");
    });
  });
});
