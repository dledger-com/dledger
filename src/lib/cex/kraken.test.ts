import { describe, it, expect } from "vitest";
import { KrakenAdapter, krakenSign, KRAKEN_ASSET_MAP } from "./kraken.js";

describe("KrakenAdapter", () => {
  const adapter = new KrakenAdapter();

  describe("normalizeAsset", () => {
    it("maps XXBT to BTC", () => {
      expect(adapter.normalizeAsset("XXBT")).toBe("BTC");
    });

    it("maps XBT to BTC", () => {
      expect(adapter.normalizeAsset("XBT")).toBe("BTC");
    });

    it("maps XETH to ETH", () => {
      expect(adapter.normalizeAsset("XETH")).toBe("ETH");
    });

    it("maps ZUSD to USD", () => {
      expect(adapter.normalizeAsset("ZUSD")).toBe("USD");
    });

    it("maps ZEUR to EUR", () => {
      expect(adapter.normalizeAsset("ZEUR")).toBe("EUR");
    });

    it("strips staking suffix .S", () => {
      expect(adapter.normalizeAsset("XETH.S")).toBe("ETH");
    });

    it("strips margin suffix .M", () => {
      expect(adapter.normalizeAsset("XXBT.M")).toBe("BTC");
    });

    it("passes through unknown codes", () => {
      expect(adapter.normalizeAsset("UNKNOWN123")).toBe("UNKNOWN123");
    });

    it("passes through already-normal codes", () => {
      expect(adapter.normalizeAsset("DOT")).toBe("DOT");
      expect(adapter.normalizeAsset("USDC")).toBe("USDC");
    });
  });

  describe("krakenSign", () => {
    it("produces a base64 string", async () => {
      // Use a dummy secret (base64-encoded)
      const secret = btoa("test-secret-key-for-hmac-testing!");
      const path = "/0/private/Ledgers";
      const nonce = 1234567890000;
      const postData = "nonce=1234567890000&ofs=0";

      const signature = await krakenSign(path, nonce, postData, secret);

      // Should be a non-empty base64 string
      expect(signature).toBeTruthy();
      expect(typeof signature).toBe("string");
      // Base64 characters only
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it("produces different signatures for different nonces", async () => {
      const secret = btoa("test-secret-key-for-hmac-testing!");
      const path = "/0/private/Ledgers";
      const postData1 = "nonce=1000&ofs=0";
      const postData2 = "nonce=2000&ofs=0";

      const sig1 = await krakenSign(path, 1000, postData1, secret);
      const sig2 = await krakenSign(path, 2000, postData2, secret);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("exchangeId", () => {
    it("is kraken", () => {
      expect(adapter.exchangeId).toBe("kraken");
    });
  });

  describe("exchangeName", () => {
    it("is Kraken", () => {
      expect(adapter.exchangeName).toBe("Kraken");
    });
  });

  describe("KRAKEN_ASSET_MAP", () => {
    it("covers major crypto assets", () => {
      expect(KRAKEN_ASSET_MAP["XXBT"]).toBe("BTC");
      expect(KRAKEN_ASSET_MAP["XETH"]).toBe("ETH");
      expect(KRAKEN_ASSET_MAP["XXRP"]).toBe("XRP");
    });

    it("covers major fiat currencies", () => {
      expect(KRAKEN_ASSET_MAP["ZUSD"]).toBe("USD");
      expect(KRAKEN_ASSET_MAP["ZEUR"]).toBe("EUR");
      expect(KRAKEN_ASSET_MAP["ZGBP"]).toBe("GBP");
    });
  });
});
