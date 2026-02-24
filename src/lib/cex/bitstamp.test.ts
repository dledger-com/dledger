import { describe, it, expect } from "vitest";
import { BitstampAdapter, bitstampSign } from "./bitstamp.js";

describe("BitstampAdapter", () => {
  const adapter = new BitstampAdapter();

  describe("normalizeAsset", () => {
    it("maps btc to BTC", () => {
      expect(adapter.normalizeAsset("btc")).toBe("BTC");
    });

    it("maps usd to USD", () => {
      expect(adapter.normalizeAsset("usd")).toBe("USD");
    });

    it("maps eth to ETH", () => {
      expect(adapter.normalizeAsset("eth")).toBe("ETH");
    });

    it("handles already-uppercase codes", () => {
      expect(adapter.normalizeAsset("SOL")).toBe("SOL");
    });

    it("handles mixed-case codes", () => {
      expect(adapter.normalizeAsset("Matic")).toBe("MATIC");
    });
  });

  describe("bitstampSign", () => {
    it("produces a hex string", async () => {
      const signature = await bitstampSign(
        "test-api-key",
        "test-secret",
        "POST",
        "/api/v2/user_transactions/",
        "",
        "application/x-www-form-urlencoded",
        "test-nonce-uuid",
        "1700000000000",
        "offset=0&limit=1000&sort=asc",
      );

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Should be a hex string (64 chars for SHA-256)
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different signatures for different inputs", async () => {
      const sig1 = await bitstampSign(
        "key1",
        "secret1",
        "POST",
        "/api/v2/user_transactions/",
        "",
        "application/x-www-form-urlencoded",
        "nonce1",
        "1000",
        "offset=0",
      );

      const sig2 = await bitstampSign(
        "key2",
        "secret2",
        "POST",
        "/api/v2/user_transactions/",
        "",
        "application/x-www-form-urlencoded",
        "nonce2",
        "2000",
        "offset=100",
      );

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different nonces", async () => {
      const sig1 = await bitstampSign(
        "key", "secret", "POST", "/api/v2/user_transactions/", "",
        "application/x-www-form-urlencoded", "nonce-aaa", "1000", "offset=0",
      );

      const sig2 = await bitstampSign(
        "key", "secret", "POST", "/api/v2/user_transactions/", "",
        "application/x-www-form-urlencoded", "nonce-bbb", "1000", "offset=0",
      );

      expect(sig1).not.toBe(sig2);
    });

    it("produces consistent signatures for identical inputs", async () => {
      const args = [
        "key", "secret", "POST", "/api/v2/user_transactions/", "",
        "application/x-www-form-urlencoded", "nonce", "1000", "offset=0",
      ] as const;

      const sig1 = await bitstampSign(...args);
      const sig2 = await bitstampSign(...args);

      expect(sig1).toBe(sig2);
    });
  });

  describe("exchangeId", () => {
    it("is bitstamp", () => {
      expect(adapter.exchangeId).toBe("bitstamp");
    });
  });

  describe("exchangeName", () => {
    it("is Bitstamp", () => {
      expect(adapter.exchangeName).toBe("Bitstamp");
    });
  });
});
