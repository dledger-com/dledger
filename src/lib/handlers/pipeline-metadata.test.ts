import { describe, it, expect } from "vitest";
import { buildTxGroupMetadata } from "./pipeline.js";
import type { TxHashGroup } from "./types.js";
import type { ChainInfo } from "../types/index.js";

const ethChain: ChainInfo = {
  chain_id: 1,
  name: "Ethereum",
  native_currency: "ETH",
  decimals: 18,
};

function makeGroup(overrides: Partial<TxHashGroup> = {}): TxHashGroup {
  return {
    hash: "0xabc123",
    timestamp: "1700000000",
    normal: null,
    internals: [],
    erc20s: [],
    erc721s: [],
    erc1155s: [],
    ...overrides,
  };
}

describe("buildTxGroupMetadata", () => {
  it("always includes hash and chain info", () => {
    const meta = buildTxGroupMetadata(makeGroup(), ethChain);

    expect(meta["tx:hash"]).toBe("0xabc123");
    expect(meta["tx:chain_id"]).toBe("1");
    expect(meta["tx:chain_name"]).toBe("Ethereum");
  });

  it("includes from/to/status from normal tx", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        normal: {
          hash: "0xabc123",
          timeStamp: "1700000000",
          from: "0xsender",
          to: "0xreceiver",
          value: "0",
          isError: "0",
          gasUsed: "21000",
          gasPrice: "20000000000",
        },
      }),
      ethChain,
    );

    expect(meta["tx:from"]).toBe("0xsender");
    expect(meta["tx:to"]).toBe("0xreceiver");
    expect(meta["tx:status"]).toBe("success");
    expect(meta["tx:gas_used"]).toBe("21000");
    expect(meta["tx:gas_price_gwei"]).toBe("20");
    expect(meta["tx:gas_fee"]).toBeDefined();
  });

  it("marks failed transactions", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        normal: {
          hash: "0xabc123",
          timeStamp: "1700000000",
          from: "0xsender",
          to: "0xreceiver",
          value: "0",
          isError: "1",
          gasUsed: "0",
          gasPrice: "0",
        },
      }),
      ethChain,
    );

    expect(meta["tx:status"]).toBe("failed");
  });

  it("includes native value when non-zero", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        normal: {
          hash: "0xabc123",
          timeStamp: "1700000000",
          from: "0xsender",
          to: "0xreceiver",
          value: "1000000000000000000", // 1 ETH
          isError: "0",
          gasUsed: "0",
          gasPrice: "0",
        },
      }),
      ethChain,
    );

    expect(meta["tx:value"]).toBe("1");
  });

  it("omits value when zero", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        normal: {
          hash: "0xabc123",
          timeStamp: "1700000000",
          from: "0xsender",
          to: "0xreceiver",
          value: "0",
          isError: "0",
          gasUsed: "0",
          gasPrice: "0",
        },
      }),
      ethChain,
    );

    expect(meta["tx:value"]).toBeUndefined();
  });

  it("includes optional fields when present", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        normal: {
          hash: "0xabc123",
          timeStamp: "1700000000",
          from: "0xsender",
          to: "0xreceiver",
          value: "0",
          isError: "0",
          gasUsed: "0",
          gasPrice: "0",
          blockNumber: "18500000",
          nonce: "42",
          functionName: "swap(uint256,uint256)",
        },
      }),
      ethChain,
    );

    expect(meta["tx:block"]).toBe("18500000");
    expect(meta["tx:nonce"]).toBe("42");
    expect(meta["tx:function"]).toBe("swap(uint256,uint256)");
  });

  it("counts ERC-20 transfers and lists contract addresses", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        erc20s: [
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", value: "100", contractAddress: "0xToken1", tokenName: "T1", tokenSymbol: "T1", tokenDecimal: "18" },
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", value: "200", contractAddress: "0xToken2", tokenName: "T2", tokenSymbol: "T2", tokenDecimal: "18" },
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", value: "300", contractAddress: "0xToken1", tokenName: "T1", tokenSymbol: "T1", tokenDecimal: "18" },
        ],
      }),
      ethChain,
    );

    expect(meta["tx:erc20_count"]).toBe("3");
    // Unique contracts, lowercased
    expect(meta["tx:contracts"]).toBe("0xtoken1,0xtoken2");
  });

  it("counts internal transactions", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        internals: [
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", value: "100", isError: "0", traceId: "0" },
        ],
      }),
      ethChain,
    );

    expect(meta["tx:internal_count"]).toBe("1");
  });

  it("counts NFT transfers", () => {
    const meta = buildTxGroupMetadata(
      makeGroup({
        erc721s: [
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", contractAddress: "0xnft", tokenID: "1", tokenName: "NFT", tokenSymbol: "NFT" },
        ],
        erc1155s: [
          { hash: "0xabc", timeStamp: "1700000000", from: "0xa", to: "0xb", contractAddress: "0xnft2", tokenID: "2", tokenValue: "5", tokenName: "NFT2", tokenSymbol: "NFT2" },
        ],
      }),
      ethChain,
    );

    expect(meta["tx:nft_count"]).toBe("2");
  });

  it("omits counts when zero", () => {
    const meta = buildTxGroupMetadata(makeGroup(), ethChain);

    expect(meta["tx:erc20_count"]).toBeUndefined();
    expect(meta["tx:internal_count"]).toBeUndefined();
    expect(meta["tx:nft_count"]).toBeUndefined();
    expect(meta["tx:contracts"]).toBeUndefined();
  });
});
