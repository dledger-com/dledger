import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../test/helpers.js";
import type { SqlJsBackend } from "./sql-js-backend.js";
import { chainIdToDefiLlamaChain, findMissingRates } from "./exchange-rate-historical.js";

describe("chainIdToDefiLlamaChain", () => {
  it("maps Ethereum mainnet", () => {
    expect(chainIdToDefiLlamaChain(1)).toBe("ethereum");
  });

  it("maps L2 chains", () => {
    expect(chainIdToDefiLlamaChain(10)).toBe("optimism");
    expect(chainIdToDefiLlamaChain(42161)).toBe("arbitrum");
    expect(chainIdToDefiLlamaChain(8453)).toBe("base");
    expect(chainIdToDefiLlamaChain(137)).toBe("polygon");
  });

  it("maps alt-L1 chains", () => {
    expect(chainIdToDefiLlamaChain(56)).toBe("bsc");
    expect(chainIdToDefiLlamaChain(43114)).toBe("avax");
    expect(chainIdToDefiLlamaChain(250)).toBe("fantom");
  });

  it("maps additional chains", () => {
    expect(chainIdToDefiLlamaChain(100)).toBe("gnosis");
    expect(chainIdToDefiLlamaChain(59144)).toBe("linea");
    expect(chainIdToDefiLlamaChain(534352)).toBe("scroll");
    expect(chainIdToDefiLlamaChain(81457)).toBe("blast");
    expect(chainIdToDefiLlamaChain(1284)).toBe("moonbeam");
    expect(chainIdToDefiLlamaChain(5000)).toBe("mantle");
  });

  it("returns null for unknown chain ID", () => {
    expect(chainIdToDefiLlamaChain(999999)).toBeNull();
  });
});

describe("findMissingRates source classification", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
    await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: true });
  });

  it("classifies fiat currencies as frankfurter", async () => {
    await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: false });

    const requests = await findMissingRates(backend, "USD", [
      { currency: "EUR", date: "2024-01-15" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].source).toBe("frankfurter");
    expect(requests[0].currency).toBe("EUR");
    expect(requests[0].dates).toEqual(["2024-01-15"]);
  });

  it("classifies known crypto (with COINGECKO_IDS entry) as defillama", async () => {
    await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });

    const requests = await findMissingRates(backend, "USD", [
      { currency: "BTC", date: "2024-01-15" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].source).toBe("defillama");
  });

  it("classifies currencies with token addresses as defillama", async () => {
    await backend.createCurrency({ code: "OBSCURE", name: "Obscure Token", decimal_places: 18, is_base: false });
    await backend.setCurrencyTokenAddress("OBSCURE", "ethereum", "0xdeadbeef");

    const requests = await findMissingRates(backend, "USD", [
      { currency: "OBSCURE", date: "2024-06-01" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].source).toBe("defillama");
  });

  it("skips unknown crypto with no COINGECKO_IDS and no token address", async () => {
    await backend.createCurrency({ code: "RANDOMTOKEN", name: "Random", decimal_places: 18, is_base: false });

    const requests = await findMissingRates(backend, "USD", [
      { currency: "RANDOMTOKEN", date: "2024-03-01" },
    ]);

    expect(requests).toHaveLength(0); // No pricing path — skipped
  });

  it("respects DB-stored rate source override", async () => {
    await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });
    await backend.setCurrencyRateSource("BTC", "binance", "user");

    const requests = await findMissingRates(backend, "USD", [
      { currency: "BTC", date: "2024-01-15" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].source).toBe("binance");
  });

  it("respects rate_source=none to skip currency", async () => {
    await backend.createCurrency({ code: "SPAM", name: "Spam Token", decimal_places: 18, is_base: false });
    await backend.setCurrencyRateSource("SPAM", "none", "auto");

    const requests = await findMissingRates(backend, "USD", [
      { currency: "SPAM", date: "2024-01-15" },
    ]);

    expect(requests).toHaveLength(0);
  });

  it("deduplicates currency-date pairs", async () => {
    await backend.createCurrency({ code: "ETH", name: "Ethereum", decimal_places: 18, is_base: false });

    const requests = await findMissingRates(backend, "USD", [
      { currency: "ETH", date: "2024-01-15" },
      { currency: "ETH", date: "2024-01-15" },
      { currency: "ETH", date: "2024-01-16" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].dates).toEqual(["2024-01-15", "2024-01-16"]);
  });

  it("skips base currency", async () => {
    const requests = await findMissingRates(backend, "USD", [
      { currency: "USD", date: "2024-01-15" },
    ]);

    expect(requests).toHaveLength(0);
  });

  it("skips dates that already have rates", async () => {
    await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: false });
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-15",
      from_currency: "EUR", to_currency: "USD",
      rate: "1.10", source: "frankfurter",
    });

    // getExchangeRatesBatch considers "on or before" — so 2024-06-15 covers itself
    // but 2024-01-01 (before) has no prior rate and should be missing
    const requests = await findMissingRates(backend, "USD", [
      { currency: "EUR", date: "2024-06-15" },
      { currency: "EUR", date: "2024-01-01" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].dates).toEqual(["2024-01-01"]);
  });

  it("groups multiple currencies by source", async () => {
    await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: false });
    await backend.createCurrency({ code: "GBP", name: "Pound", decimal_places: 2, is_base: false });
    await backend.createCurrency({ code: "BTC", name: "Bitcoin", decimal_places: 8, is_base: false });

    const requests = await findMissingRates(backend, "USD", [
      { currency: "EUR", date: "2024-01-15" },
      { currency: "GBP", date: "2024-01-15" },
      { currency: "BTC", date: "2024-01-15" },
    ]);

    const frankfurter = requests.filter((r) => r.source === "frankfurter");
    const defillama = requests.filter((r) => r.source === "defillama");

    expect(frankfurter).toHaveLength(2);
    expect(defillama).toHaveLength(1);
    expect(defillama[0].currency).toBe("BTC");
  });

  it("handles DB-stored source for cryptocompare", async () => {
    await backend.createCurrency({ code: "SOL", name: "Solana", decimal_places: 9, is_base: false });
    await backend.setCurrencyRateSource("SOL", "cryptocompare", "user");

    const requests = await findMissingRates(backend, "USD", [
      { currency: "SOL", date: "2024-05-01" },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].source).toBe("cryptocompare");
  });
});
