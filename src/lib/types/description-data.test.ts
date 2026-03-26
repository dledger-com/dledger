import { describe, it, expect } from "vitest";
import { renderDescription, type DescriptionData } from "./description-data.js";

describe("renderDescription", () => {
  it("renders cex-trade", () => {
    expect(renderDescription({ type: "cex-trade", exchange: "Binance", spent: "USDT", received: "BTC" }))
      .toBe("Binance trade: USDT → BTC");
  });

  it("renders cex-transfer deposit", () => {
    expect(renderDescription({ type: "cex-transfer", exchange: "Kraken", direction: "deposit", currency: "ETH" }))
      .toBe("Kraken deposit: ETH");
  });

  it("renders cex-transfer withdrawal", () => {
    expect(renderDescription({ type: "cex-transfer", exchange: "Coinbase", direction: "withdrawal", currency: "BTC" }))
      .toBe("Coinbase withdrawal: BTC");
  });

  it("renders cex-reward", () => {
    expect(renderDescription({ type: "cex-reward", exchange: "Kraken", kind: "staking", currency: "DOT" }))
      .toBe("Kraken staking reward: DOT");
  });

  it("renders cex-operation", () => {
    expect(renderDescription({ type: "cex-operation", exchange: "Binance", operation: "fee", currency: "BNB" }))
      .toBe("Binance fee: BNB");
  });

  it("renders bank with bank name", () => {
    expect(renderDescription({ type: "bank", bank: "N26", text: "REWE grocery store" }))
      .toBe("N26: REWE grocery store");
  });

  it("renders bank without bank name", () => {
    expect(renderDescription({ type: "bank", bank: "", text: "REWE grocery store" }))
      .toBe("REWE grocery store");
  });

  it("renders onchain-transfer sent", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Ethereum", currency: "ETH",
      direction: "sent", counterparty: "0xabc...def", txHash: "0x123",
    })).toBe("Send ETH on Ethereum to 0xabc...def");
  });

  it("renders onchain-transfer received without counterparty", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Polygon", currency: "MATIC",
      direction: "received", txHash: "0x456",
    })).toBe("Receive MATIC on Polygon");
  });

  it("renders onchain-transfer self with token count", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Ethereum", currency: "USDC",
      direction: "self", txHash: "0x789", tokenCount: 3,
    })).toBe("Self-transfer USDC on Ethereum (3 tokens)");
  });

  it("renders onchain-contract creation", () => {
    expect(renderDescription({
      type: "onchain-contract", chain: "Ethereum", currency: "ETH",
      action: "creation", txHash: "0xaaa",
    })).toBe("Contract creation on Ethereum");
  });

  it("renders onchain-contract internal-transfer", () => {
    expect(renderDescription({
      type: "onchain-contract", chain: "BSC", currency: "BNB",
      action: "internal-transfer", txHash: "0xbbb",
    })).toBe("Internal transfer BNB on BSC");
  });

  it("renders defi with summary", () => {
    expect(renderDescription({
      type: "defi", protocol: "Uniswap", action: "swap",
      chain: "Ethereum", txHash: "0xccc", summary: "Swap 1 ETH for 2000 USDC",
    })).toBe("Swap 1 ETH for 2000 USDC");
  });

  it("renders defi without summary", () => {
    expect(renderDescription({
      type: "defi", protocol: "Aave", action: "supply",
      chain: "Ethereum", txHash: "0xddd",
    })).toBe("Aave: supply on Ethereum");
  });

  it("renders generic-import", () => {
    expect(renderDescription({ type: "generic-import", source: "csv", text: "Monthly salary", presetId: "n26" }))
      .toBe("Monthly salary");
  });

  it("renders manual", () => {
    expect(renderDescription({ type: "manual", text: "Office supplies" }))
      .toBe("Office supplies");
  });

  it("renders system reversal", () => {
    expect(renderDescription({ type: "system", action: "reversal", ref: "entry-123" }))
      .toBe("Reversal of: entry-123");
  });

  it("renders system pad", () => {
    expect(renderDescription({ type: "system", action: "pad" }))
      .toBe("Pad");
  });

});

describe("DescriptionData round-trip", () => {
  const cases: DescriptionData[] = [
    { type: "cex-trade", exchange: "Binance", spent: "USDT", received: "BTC" },
    { type: "cex-transfer", exchange: "Kraken", direction: "deposit", currency: "ETH" },
    { type: "cex-reward", exchange: "Coinbase", kind: "staking", currency: "DOT" },
    { type: "cex-operation", exchange: "OKX", operation: "fee", currency: "USDT" },
    { type: "bank", bank: "N26", text: "Groceries" },
    { type: "onchain-transfer", chain: "Ethereum", currency: "ETH", direction: "sent", txHash: "0x123" },
    { type: "onchain-contract", chain: "BSC", currency: "BNB", action: "creation", txHash: "0x456" },
    { type: "defi", protocol: "Uniswap", action: "swap", chain: "Ethereum", txHash: "0x789" },
    { type: "generic-import", source: "csv", text: "Test import" },
    { type: "manual", text: "Manual entry" },
    { type: "system", action: "reversal", ref: "abc" },
  ];

  for (const data of cases) {
    it(`serializes and deserializes ${data.type}`, () => {
      const json = JSON.stringify(data);
      const parsed = JSON.parse(json) as DescriptionData;
      expect(renderDescription(parsed)).toBe(renderDescription(data));
    });
  }
});
