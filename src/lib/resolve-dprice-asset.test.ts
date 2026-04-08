import { describe, it, expect } from "vitest";
import { resolveDpriceAsset } from "./exchange-rate-sync.js";
import type { DpriceClient, DpriceAssetInfo } from "./dprice-client.js";

/** Minimal mock client that returns pre-configured assets from queryAssets */
function mockClient(assets: DpriceAssetInfo[]): DpriceClient {
  return {
    async queryAssets() { return assets; },
    async queryAssetsBatch(symbols: string[]) { const m = new Map<string, typeof assets>(); for (const s of symbols) m.set(s.toUpperCase(), assets.filter(a => a.symbol.toUpperCase() === s.toUpperCase())); return m; },
    async health() { return { assets: 0, prices: 0 }; },
    async getRate() { return null; },
    async getRates() { return []; },
    async getPrices() { return { from: "", to: "", currencies: [] }; },
    async sync() { return ""; },
    async syncLatest() { return ""; },
    async latestDate() { return null; },
    async ensurePrices() { return []; },
    async exportDb() { return new Uint8Array(); },
    async importDb() { return ""; },
    async proxyAsset() { return null; },
  };
}

const DEPIN_HL: DpriceAssetInfo = {
  id: "crypto:cg:depin",
  symbol: "DEPIN",
  name: "DEPIN",
  type: "crypto",
  coingecko_id: "depin",
  contract_chain: "hyperliquid",
  contract_address: "0x934a7e00c1b047c2d27967663f58befe",
  first_price_date: "2025-01-04",
  last_price_date: "2026-03-17",
};

const DEPIN_BASE: DpriceAssetInfo = {
  id: "crypto:cg:depin-baby",
  symbol: "DEPIN",
  name: "DePIN Baby",
  type: "crypto",
  contract_chain: "base",
  contract_address: "0xb4f4776219a20720d03eae922de341a9586de6c9",
  first_price_date: "2025-08-30",
  last_price_date: "2026-03-15",
};

const DEPIN_NO_PRICES: DpriceAssetInfo = {
  id: "crypto:cp:depin-depin-finance",
  symbol: "DEPIN",
  name: "DePIN Finance",
  type: "crypto",
  first_price_date: null,
  last_price_date: null,
};

describe("resolveDpriceAsset disambiguation", () => {
  it("returns the single result when only one asset matches", async () => {
    const result = await resolveDpriceAsset(mockClient([DEPIN_HL]), "DEPIN", "");
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("returns none when no assets match", async () => {
    const result = await resolveDpriceAsset(mockClient([]), "DEPIN", "");
    expect(result).toBe("none");
  });

  it("disambiguates by contract address", async () => {
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL, DEPIN_BASE, DEPIN_NO_PRICES]),
      "DEPIN", "",
      { chain: "hyperliquid", contract_address: "0x934a7e00c1b047c2d27967663f58befe" },
    );
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("disambiguates by origin chain hint", async () => {
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL, DEPIN_BASE, DEPIN_NO_PRICES]),
      "DEPIN", "",
      undefined,
      { originChain: "hyperliquid" },
    );
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("disambiguates by has-prices filter", async () => {
    // Only one has prices
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL, DEPIN_NO_PRICES]),
      "DEPIN", "",
      undefined,
      undefined,
    );
    // After has-prices filter, only DEPIN_HL remains
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("disambiguates by name match", async () => {
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL, DEPIN_BASE]),
      "DEPIN", "",
      undefined,
      { name: "DEPIN" },
    );
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("picks best candidate when no heuristic resolves", async () => {
    // Two candidates with prices, no distinguishing hints —
    // picks the one with most recent last_price_date
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL, DEPIN_BASE]),
      "DEPIN", "",
    );
    // DEPIN_HL has last_price_date "2026-03-17" vs DEPIN_BASE "2026-03-15"
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });

  it("backward compat: no hints still works", async () => {
    const result = await resolveDpriceAsset(
      mockClient([DEPIN_HL]),
      "DEPIN", "crypto",
    );
    expect(result).toEqual({ id: DEPIN_HL.id, type: "crypto", coingecko_id: "depin" });
  });
});
