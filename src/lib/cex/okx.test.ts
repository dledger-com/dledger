import { describe, it, expect } from "vitest";
import { OkxAdapter, okxSign } from "./okx.js";

describe("OkxAdapter", () => {
  const adapter = new OkxAdapter();

  describe("normalizeAsset", () => {
    it("passes through standard codes as identity", () => {
      expect(adapter.normalizeAsset("BTC")).toBe("BTC");
      expect(adapter.normalizeAsset("ETH")).toBe("ETH");
      expect(adapter.normalizeAsset("USDT")).toBe("USDT");
    });

    it("passes through unknown codes as identity", () => {
      expect(adapter.normalizeAsset("UNKNOWN123")).toBe("UNKNOWN123");
    });

    it("passes through fiat codes", () => {
      expect(adapter.normalizeAsset("USD")).toBe("USD");
      expect(adapter.normalizeAsset("EUR")).toBe("EUR");
    });
  });

  describe("okxSign", () => {
    it("produces a base64 string (not hex)", async () => {
      const timestamp = "2024-01-15T10:30:00.000Z";
      const method = "GET";
      const requestPath = "/api/v5/trade/fills-history?instType=SPOT";
      const body = "";
      const secret = "test-secret-key-for-hmac-testing";

      const signature = await okxSign(timestamp, method, requestPath, body, secret);

      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Base64 characters only
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it("produces different signatures for different timestamps", async () => {
      const method = "GET";
      const requestPath = "/api/v5/trade/fills-history?instType=SPOT";
      const body = "";
      const secret = "test-secret-key-for-hmac-testing";

      const sig1 = await okxSign("2024-01-15T10:30:00.000Z", method, requestPath, body, secret);
      const sig2 = await okxSign("2024-01-15T11:00:00.000Z", method, requestPath, body, secret);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different paths", async () => {
      const timestamp = "2024-01-15T10:30:00.000Z";
      const method = "GET";
      const body = "";
      const secret = "test-secret-key-for-hmac-testing";

      const sig1 = await okxSign(timestamp, method, "/api/v5/trade/fills-history", body, secret);
      const sig2 = await okxSign(timestamp, method, "/api/v5/asset/deposit-history", body, secret);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different secrets", async () => {
      const timestamp = "2024-01-15T10:30:00.000Z";
      const method = "GET";
      const requestPath = "/api/v5/trade/fills-history?instType=SPOT";
      const body = "";

      const sig1 = await okxSign(timestamp, method, requestPath, body, "secret-one");
      const sig2 = await okxSign(timestamp, method, requestPath, body, "secret-two");

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different methods", async () => {
      const timestamp = "2024-01-15T10:30:00.000Z";
      const requestPath = "/api/v5/trade/fills-history";
      const body = "";
      const secret = "test-secret-key-for-hmac-testing";

      const sig1 = await okxSign(timestamp, "GET", requestPath, body, secret);
      const sig2 = await okxSign(timestamp, "POST", requestPath, body, secret);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("exchangeId", () => {
    it("is okx", () => {
      expect(adapter.exchangeId).toBe("okx");
    });
  });

  describe("exchangeName", () => {
    it("is OKX", () => {
      expect(adapter.exchangeName).toBe("OKX");
    });
  });

  describe("requiresPassphrase", () => {
    it("is true", () => {
      expect(adapter.requiresPassphrase).toBe(true);
    });
  });
});
