import { describe, it, expect } from "vitest";
import { deriveTradeRate, deriveAndRecordTradeRate } from "./derive-trade-rate.js";
import type { TradeRateItem } from "./derive-trade-rate.js";
import { createTestBackend } from "../../test/helpers.js";
import { exchangeAssetsCurrency, exchangeFees } from "../accounts/paths.js";

describe("deriveTradeRate", () => {
  it("derives rate from CEX trade (2 Equity:Trading items, opposite signs)", () => {
    // Buy 1500 USDC for 1 ETH on CEX
    // Equity:Trading:ETH has +1 ETH (sold), Equity:Trading:USDC has -1500 USDC (bought)
    const items: TradeRateItem[] = [
      { account_name: exchangeAssetsCurrency("Kraken", "ETH"), currency: "ETH", amount: "-1" },
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: exchangeAssetsCurrency("Kraken", "USDC"), currency: "USDC", amount: "1500" },
      { account_name: "Equity:Trading:USDC", currency: "USDC", amount: "-1500" },
    ];
    const result = deriveTradeRate(items);
    expect(result).not.toBeNull();
    expect(result!.from_currency).toBe("ETH");
    expect(result!.to_currency).toBe("USDC");
    expect(result!.rate).toBe("1500");
  });

  it("derives correct rate even with fee items", () => {
    // Buy 1500 USDC for 1 ETH, plus a 0.01 ETH fee
    const items: TradeRateItem[] = [
      { account_name: exchangeAssetsCurrency("Kraken", "ETH"), currency: "ETH", amount: "-1" },
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: exchangeAssetsCurrency("Kraken", "USDC"), currency: "USDC", amount: "1500" },
      { account_name: "Equity:Trading:USDC", currency: "USDC", amount: "-1500" },
      { account_name: exchangeFees("Kraken"), currency: "ETH", amount: "0.01" },
      { account_name: exchangeAssetsCurrency("Kraken", "ETH"), currency: "ETH", amount: "-0.01" },
    ];
    const result = deriveTradeRate(items);
    expect(result).not.toBeNull();
    // Fee items are on Assets/Expenses, not Equity:Trading, so Trading items are clean
    expect(result!.from_currency).toBe("ETH");
    expect(result!.to_currency).toBe("USDC");
    expect(result!.rate).toBe("1500");
  });

  it("derives rate via Asset fallback (DeFi swap, no Trading items)", () => {
    // DeFi swap: send 1 ETH, receive 1500 USDC (no Equity:Trading accounts)
    const items: TradeRateItem[] = [
      { account_name: "Assets:Wallet:ETH", currency: "ETH", amount: "-1" },
      { account_name: "Assets:Wallet:USDC", currency: "USDC", amount: "1500" },
      { account_name: "Equity:Wallet:External:Uniswap", currency: "ETH", amount: "1" },
      { account_name: "Equity:Wallet:External:Uniswap", currency: "USDC", amount: "-1500" },
    ];
    const result = deriveTradeRate(items);
    expect(result).not.toBeNull();
    expect(result!.from_currency).toBe("ETH");
    expect(result!.to_currency).toBe("USDC");
    expect(result!.rate).toBe("1500");
  });

  it("returns null for single currency transaction", () => {
    const items: TradeRateItem[] = [
      { account_name: "Assets:Bank", currency: "USD", amount: "100" },
      { account_name: "Expenses:Food", currency: "USD", amount: "-100" },
    ];
    const result = deriveTradeRate(items);
    expect(result).toBeNull();
  });

  it("returns null for three currency transaction", () => {
    const items: TradeRateItem[] = [
      { account_name: "Assets:Wallet:ETH", currency: "ETH", amount: "-1" },
      { account_name: "Assets:Wallet:USDC", currency: "USDC", amount: "1500" },
      { account_name: "Assets:Wallet:BTC", currency: "BTC", amount: "0.05" },
    ];
    const result = deriveTradeRate(items);
    expect(result).toBeNull();
  });

  it("returns null when one currency nets to zero", () => {
    // ETH nets to zero in Equity:Trading
    const items: TradeRateItem[] = [
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "-1" },
      { account_name: "Equity:Trading:USDC", currency: "USDC", amount: "-1500" },
    ];
    const result = deriveTradeRate(items);
    // Only 1 non-zero currency in Trading → null; Assets fallback has nothing → null
    expect(result).toBeNull();
  });

  it("returns null when both Trading currencies have same sign", () => {
    const items: TradeRateItem[] = [
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: "Equity:Trading:USDC", currency: "USDC", amount: "1500" },
    ];
    const result = deriveTradeRate(items);
    expect(result).toBeNull();
  });

  it("handles ledger file pattern (Equity:Trading:X with BTC and USD)", () => {
    // From "1 BTC @ 50000 USD" in a ledger file:
    // Assets:Exchange:BTC  +1 BTC
    // Equity:Trading:BTC   -1 BTC  (negative = bought in Trading convention)
    // Equity:Trading:BTC   +50000 USD (positive = sold)
    const items: TradeRateItem[] = [
      { account_name: "Assets:Exchange:BTC", currency: "BTC", amount: "1" },
      { account_name: "Equity:Trading:BTC", currency: "BTC", amount: "-1" },
      { account_name: "Equity:Trading:BTC", currency: "USD", amount: "50000" },
    ];
    const result = deriveTradeRate(items);
    expect(result).not.toBeNull();
    expect(result!.from_currency).toBe("USD");
    expect(result!.to_currency).toBe("BTC");
    expect(result!.rate).toBe("0.00002");
  });
});

describe("deriveAndRecordTradeRate integration", () => {
  it("records rate from ledger import with @ PRICE", async () => {
    const backend = await createTestBackend();
    await backend.createCurrency({ code: "BTC", asset_type: "", name: "Bitcoin", decimal_places: 8 });
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 });

    const items: TradeRateItem[] = [
      { account_name: "Assets:Exchange:BTC", currency: "BTC", amount: "1" },
      { account_name: "Equity:Trading:BTC", currency: "BTC", amount: "-1" },
      { account_name: "Equity:Trading:BTC", currency: "USD", amount: "50000" },
    ];

    const result = await deriveAndRecordTradeRate(backend, "2024-06-01", items);
    expect(result).not.toBeNull();

    // Verify rate was recorded
    const rate = await backend.getExchangeRate("USD", "BTC", "2024-06-01");
    expect(rate).not.toBeNull();
    expect(rate).toBe("0.00002");
  });

  it("transaction rate overwrites API rate but not manual rate", async () => {
    const backend = await createTestBackend();
    await backend.createCurrency({ code: "ETH", asset_type: "", name: "Ethereum", decimal_places: 18 });
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 });

    // First: record an API rate
    await backend.recordExchangeRate({
      id: "api-rate-1",
      date: "2024-06-01",
      from_currency: "ETH",
      to_currency: "USD",
      rate: "3000",
      source: "coingecko",
    });
    expect(await backend.getExchangeRate("ETH", "USD", "2024-06-01")).toBe("3000");

    // Transaction rate should overwrite API
    const items: TradeRateItem[] = [
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: "Equity:Trading:USDC", currency: "USD", amount: "-3100" },
    ];
    await deriveAndRecordTradeRate(backend, "2024-06-01", items);
    expect(await backend.getExchangeRate("ETH", "USD", "2024-06-01")).toBe("3100");

    // Now record a manual rate
    await backend.recordExchangeRate({
      id: "manual-rate-1",
      date: "2024-06-01",
      from_currency: "ETH",
      to_currency: "USD",
      rate: "3200",
      source: "manual",
    });
    expect(await backend.getExchangeRate("ETH", "USD", "2024-06-01")).toBe("3200");

    // Transaction rate should NOT overwrite manual
    const items2: TradeRateItem[] = [
      { account_name: "Equity:Trading:ETH", currency: "ETH", amount: "1" },
      { account_name: "Equity:Trading:USDC", currency: "USD", amount: "-2900" },
    ];
    await deriveAndRecordTradeRate(backend, "2024-06-01", items2);
    expect(await backend.getExchangeRate("ETH", "USD", "2024-06-01")).toBe("3200");
  });

  it("returns null and records nothing for non-trade entries", async () => {
    const backend = await createTestBackend();
    await backend.createCurrency({ code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2 });

    const items: TradeRateItem[] = [
      { account_name: "Assets:Bank", currency: "USD", amount: "100" },
      { account_name: "Expenses:Food", currency: "USD", amount: "-100" },
    ];

    const result = await deriveAndRecordTradeRate(backend, "2024-06-01", items);
    expect(result).toBeNull();
  });
});
