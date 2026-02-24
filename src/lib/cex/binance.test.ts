import { describe, it, expect } from "vitest";
import { BinanceAdapter, binanceSign, BINANCE_ASSET_MAP } from "./binance.js";

describe("BinanceAdapter", () => {
  const adapter = new BinanceAdapter();

  describe("normalizeAsset", () => {
    it("maps IOTA to MIOTA", () => {
      expect(adapter.normalizeAsset("IOTA")).toBe("MIOTA");
    });

    it("passes through standard codes", () => {
      expect(adapter.normalizeAsset("BTC")).toBe("BTC");
      expect(adapter.normalizeAsset("ETH")).toBe("ETH");
      expect(adapter.normalizeAsset("USDT")).toBe("USDT");
    });

    it("passes through unknown codes as identity", () => {
      expect(adapter.normalizeAsset("UNKNOWN123")).toBe("UNKNOWN123");
    });

    it("handles YOOSHI edge case", () => {
      expect(adapter.normalizeAsset("YOOSHI")).toBe("YOOSHI");
    });
  });

  describe("binanceSign", () => {
    it("produces a hex string", async () => {
      const secret = "test-secret-key-for-hmac-testing";
      const queryString = "symbol=BTCUSDT&timestamp=1234567890000";

      const signature = await binanceSign(queryString, secret);

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Hex characters only
      expect(signature).toMatch(/^[0-9a-f]+$/);
      // HMAC-SHA256 produces 64 hex chars
      expect(signature).toHaveLength(64);
    });

    it("produces different signatures for different inputs", async () => {
      const secret = "test-secret-key-for-hmac-testing";
      const qs1 = "symbol=BTCUSDT&timestamp=1000";
      const qs2 = "symbol=ETHUSDT&timestamp=1000";

      const sig1 = await binanceSign(qs1, secret);
      const sig2 = await binanceSign(qs2, secret);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different secrets", async () => {
      const queryString = "symbol=BTCUSDT&timestamp=1234567890000";

      const sig1 = await binanceSign(queryString, "secret-one");
      const sig2 = await binanceSign(queryString, "secret-two");

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("exchangeId", () => {
    it("is binance", () => {
      expect(adapter.exchangeId).toBe("binance");
    });
  });

  describe("exchangeName", () => {
    it("is Binance", () => {
      expect(adapter.exchangeName).toBe("Binance");
    });
  });

  describe("BINANCE_ASSET_MAP", () => {
    it("has IOTA mapped to MIOTA", () => {
      expect(BINANCE_ASSET_MAP["IOTA"]).toBe("MIOTA");
    });

    it("has YOOSHI entry", () => {
      expect(BINANCE_ASSET_MAP["YOOSHI"]).toBe("YOOSHI");
    });
  });
});
