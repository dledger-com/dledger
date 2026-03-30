import { describe, it, expect } from "vitest";
import { renderDescription, type DescriptionData } from "./description-data.js";

describe("renderDescription", () => {
  it("renders cex-trade", () => {
    expect(renderDescription({ type: "cex-trade", exchange: "Binance", spent: "USDT", received: "BTC" }))
      .toBe("Binance: Trade USDT → BTC");
  });

  it("renders cex-transfer deposit", () => {
    expect(renderDescription({ type: "cex-transfer", exchange: "Kraken", direction: "deposit", currency: "ETH" }))
      .toBe("Kraken: Deposit ETH");
  });

  it("renders cex-transfer withdrawal", () => {
    expect(renderDescription({ type: "cex-transfer", exchange: "Coinbase", direction: "withdrawal", currency: "BTC" }))
      .toBe("Coinbase: Withdrawal BTC");
  });

  it("renders cex-reward", () => {
    expect(renderDescription({ type: "cex-reward", exchange: "Kraken", kind: "staking", currency: "DOT" }))
      .toBe("Kraken: Staking reward DOT");
  });

  it("renders cex-operation", () => {
    expect(renderDescription({ type: "cex-operation", exchange: "Binance", operation: "fee", currency: "BNB" }))
      .toBe("Binance: Fee BNB");
  });

  it("renders bank with bank name", () => {
    expect(renderDescription({ type: "bank", bank: "N26", text: "REWE grocery store" }))
      .toBe("N26: REWE grocery store");
  });

  it("renders bank without bank name", () => {
    expect(renderDescription({ type: "bank", bank: "", text: "REWE grocery store" }))
      .toBe("REWE grocery store");
  });

  it("renders onchain-transfer sent with counterparty", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Ethereum", currency: "ETH",
      direction: "sent", counterparty: "0xabc...def", txHash: "0x123",
    })).toBe("Ethereum: Send ETH to 0xabc...def");
  });

  it("renders onchain-transfer received without counterparty", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Polygon", currency: "MATIC",
      direction: "received", txHash: "0x456",
    })).toBe("Polygon: Receive MATIC");
  });

  it("renders onchain-transfer self", () => {
    expect(renderDescription({
      type: "onchain-transfer", chain: "Ethereum", currency: "USDC",
      direction: "self", txHash: "0x789", tokenCount: 3,
    })).toBe("Ethereum: Transfer USDC");
  });

  it("renders onchain-contract creation", () => {
    expect(renderDescription({
      type: "onchain-contract", chain: "Ethereum", currency: "ETH",
      action: "creation", txHash: "0xaaa",
    })).toBe("Ethereum: Contract creation");
  });

  it("renders onchain-contract internal-transfer", () => {
    expect(renderDescription({
      type: "onchain-contract", chain: "BSC", currency: "BNB",
      action: "internal-transfer", txHash: "0xbbb",
    })).toBe("BSC: Internal transfer BNB");
  });

  it("renders defi with summary", () => {
    expect(renderDescription({
      type: "defi", protocol: "Uniswap", action: "swap",
      chain: "Ethereum", txHash: "0xccc", summary: "Uniswap: Swap WETH → USDC",
    })).toBe("Uniswap: Swap WETH → USDC");
  });

  it("renders defi without summary", () => {
    expect(renderDescription({
      type: "defi", protocol: "Aave", action: "supply",
      chain: "Ethereum", txHash: "0xddd",
    })).toBe("Aave (Ethereum): Supply");
  });

  it("renders defi multi-action via summary", () => {
    expect(renderDescription({
      type: "defi", protocol: "Aave", action: "supply+withdraw",
      chain: "Ethereum", txHash: "0xeee", summary: "Aave: Supply + Withdraw",
    })).toBe("Aave: Supply + Withdraw");
  });

  it("renders fee", () => {
    expect(renderDescription({
      type: "fee", chain: "Ethereum", currency: "ETH", txHash: "0xfff",
    })).toBe("Ethereum: Network fee");
  });

  it("renders btc-transfer sent", () => {
    expect(renderDescription({
      type: "btc-transfer", direction: "sent", txid: "abc123", counterparty: "bc1q...xyz",
    })).toBe("Bitcoin: Send BTC to bc1q...xyz");
  });

  it("renders btc-transfer received", () => {
    expect(renderDescription({
      type: "btc-transfer", direction: "received", txid: "abc123",
    })).toBe("Bitcoin: Receive BTC");
  });

  it("renders btc-transfer self", () => {
    expect(renderDescription({
      type: "btc-transfer", direction: "self", txid: "abc123",
    })).toBe("Bitcoin: Transfer BTC");
  });

  it("renders btc-transfer consolidation", () => {
    expect(renderDescription({
      type: "btc-transfer", direction: "consolidation", txid: "abc123",
    })).toBe("Bitcoin: Consolidation BTC");
  });

  it("renders sol-transfer sent", () => {
    expect(renderDescription({
      type: "sol-transfer", direction: "sent", signature: "abc", counterparty: "JUP6…4nWd",
    })).toBe("Solana: Send SOL to JUP6…4nWd");
  });

  it("renders sol-transfer received with token", () => {
    expect(renderDescription({
      type: "sol-transfer", direction: "received", signature: "abc", tokenSymbol: "USDC",
    })).toBe("Solana: Receive USDC");
  });

  it("renders sol-transfer self", () => {
    expect(renderDescription({
      type: "sol-transfer", direction: "self", signature: "abc",
    })).toBe("Solana: Transfer SOL");
  });

  it("renders sol-defi with summary", () => {
    expect(renderDescription({
      type: "sol-defi", protocol: "Jupiter", action: "swap", signature: "abc",
      summary: "Jupiter: Swap SOL → USDC",
    })).toBe("Jupiter: Swap SOL → USDC");
  });

  it("renders sol-defi without summary", () => {
    expect(renderDescription({
      type: "sol-defi", protocol: "Marinade", action: "stake", signature: "abc",
    })).toBe("Marinade (Solana): Stake");
  });

  it("renders hl-fill with spent/received", () => {
    expect(renderDescription({
      type: "hl-fill", coin: "BTC", side: "long", spent: "USDC", received: "BTC",
    })).toBe("Hyperliquid: Trade USDC → BTC");
  });

  it("renders hl-fill without spent/received", () => {
    expect(renderDescription({
      type: "hl-fill", coin: "ETH", side: "short",
    })).toBe("Hyperliquid: ETH Short");
  });

  it("renders hl-funding", () => {
    expect(renderDescription({
      type: "hl-funding", coin: "BTC", usdc: "10.5",
    })).toBe("Hyperliquid: Funding BTC");
  });

  it("renders hl-ledger", () => {
    expect(renderDescription({
      type: "hl-ledger", action: "deposit",
    })).toBe("Hyperliquid: Deposit USDC");
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
    { type: "fee", chain: "Ethereum", currency: "ETH", txHash: "0xabc" },
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
