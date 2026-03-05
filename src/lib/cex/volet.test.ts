import { describe, it, expect } from "vitest";
import { VoletAdapter, voletAuthToken, mapTransactionType } from "./volet.js";

describe("VoletAdapter", () => {
  const adapter = new VoletAdapter();

  describe("normalizeAsset", () => {
    it("uppercases lowercase codes", () => {
      expect(adapter.normalizeAsset("btc")).toBe("BTC");
    });

    it("uppercases mixed-case codes", () => {
      expect(adapter.normalizeAsset("Eur")).toBe("EUR");
    });

    it("preserves already-uppercase codes", () => {
      expect(adapter.normalizeAsset("USDT")).toBe("USDT");
    });
  });

  describe("exchangeId", () => {
    it("is volet", () => {
      expect(adapter.exchangeId).toBe("volet");
    });
  });

  describe("exchangeName", () => {
    it("is Volet", () => {
      expect(adapter.exchangeName).toBe("Volet");
    });
  });

  describe("requiresPassphrase", () => {
    it("is true", () => {
      expect(adapter.requiresPassphrase).toBe(true);
    });
  });

  describe("voletAuthToken", () => {
    it("produces a 64-char hex string", async () => {
      const token = await voletAuthToken("mySecretWord", new Date("2025-06-15T14:30:00Z"));
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces consistent tokens for identical inputs", async () => {
      const d = new Date("2025-01-01T00:00:00Z");
      const t1 = await voletAuthToken("secret", d);
      const t2 = await voletAuthToken("secret", d);
      expect(t1).toBe(t2);
    });

    it("produces different tokens for different security words", async () => {
      const d = new Date("2025-01-01T12:00:00Z");
      const t1 = await voletAuthToken("word1", d);
      const t2 = await voletAuthToken("word2", d);
      expect(t1).not.toBe(t2);
    });

    it("produces different tokens for different hours", async () => {
      const t1 = await voletAuthToken("secret", new Date("2025-06-15T14:00:00Z"));
      const t2 = await voletAuthToken("secret", new Date("2025-06-15T15:00:00Z"));
      expect(t1).not.toBe(t2);
    });

    it("uses UTC date components in the hash", async () => {
      // "secret:20250615:14" should be the prehash for this date
      const token = await voletAuthToken("secret", new Date("2025-06-15T14:30:00Z"));
      // Verify by computing expected SHA-256 of "secret:20250615:14"
      const expected = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("secret:20250615:14"),
      );
      const expectedHex = Array.from(new Uint8Array(expected))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(token).toBe(expectedHex);
    });
  });

  describe("mapTransactionType", () => {
    it("maps INNER_SYSTEM to transfer", () => {
      expect(mapTransactionType("INNER_SYSTEM")).toBe("transfer");
    });

    it("maps CURRENCY_EXCHANGE to trade", () => {
      expect(mapTransactionType("CURRENCY_EXCHANGE")).toBe("trade");
    });

    it("maps deposit types to deposit", () => {
      expect(mapTransactionType("WIRE_TRANSFER_DEPOSIT")).toBe("deposit");
      expect(mapTransactionType("CHECK_DEPOSIT")).toBe("deposit");
      expect(mapTransactionType("EXTERNAL_SYSTEM_DEPOSIT")).toBe("deposit");
    });

    it("maps withdrawal types to withdrawal", () => {
      expect(mapTransactionType("WIRE_TRANSFER_WITHDRAW")).toBe("withdrawal");
      expect(mapTransactionType("BANK_CARD_TRANSFER")).toBe("withdrawal");
      expect(mapTransactionType("ADVCASH_CARD_TRANSFER")).toBe("withdrawal");
      expect(mapTransactionType("EXTERNAL_SYSTEM_WITHDRAWAL")).toBe("withdrawal");
    });

    it("maps unknown types to other", () => {
      expect(mapTransactionType("SOMETHING_UNKNOWN")).toBe("other");
      expect(mapTransactionType("")).toBe("other");
    });
  });

  describe("fetchLedgerRecords", () => {
    it("throws if passphrase (email) is missing", async () => {
      await expect(
        adapter.fetchLedgerRecords("apiName", "secWord", undefined, undefined, undefined),
      ).rejects.toThrow("Volet requires Account Email");
    });

    it("throws if passphrase is empty string", async () => {
      await expect(
        adapter.fetchLedgerRecords("apiName", "secWord", undefined, undefined, ""),
      ).rejects.toThrow("Volet requires Account Email");
    });
  });
});
