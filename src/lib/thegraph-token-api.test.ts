import { describe, it, expect } from "vitest";
import {
  isTheGraphSupportedChain,
  amountToWei,
  convertGraphToTxHashGroups,
  type GraphTokenTransfer,
  type GraphNftTransfer,
} from "./thegraph-token-api.js";

describe("isTheGraphSupportedChain", () => {
  it("returns true for supported chains", () => {
    expect(isTheGraphSupportedChain(1)).toBe(true);
    expect(isTheGraphSupportedChain(10)).toBe(true);
    expect(isTheGraphSupportedChain(42161)).toBe(true);
    expect(isTheGraphSupportedChain(8453)).toBe(true);
    expect(isTheGraphSupportedChain(56)).toBe(true);
    expect(isTheGraphSupportedChain(137)).toBe(true);
    expect(isTheGraphSupportedChain(43114)).toBe(true);
    expect(isTheGraphSupportedChain(130)).toBe(true);
  });

  it("returns false for unsupported chains", () => {
    expect(isTheGraphSupportedChain(59144)).toBe(false); // Linea
    expect(isTheGraphSupportedChain(534352)).toBe(false); // Scroll
    expect(isTheGraphSupportedChain(100)).toBe(false); // Gnosis
    expect(isTheGraphSupportedChain(999999)).toBe(false);
  });
});

describe("amountToWei", () => {
  it("converts integer amounts", () => {
    expect(amountToWei("1", 18)).toBe("1000000000000000000");
    expect(amountToWei("100", 6)).toBe("100000000");
  });

  it("converts decimal amounts", () => {
    expect(amountToWei("1.5", 18)).toBe("1500000000000000000");
    expect(amountToWei("0.001", 18)).toBe("1000000000000000");
    expect(amountToWei("123.456", 6)).toBe("123456000");
  });

  it("handles zero", () => {
    expect(amountToWei("0", 18)).toBe("0");
  });

  it("handles very small amounts", () => {
    expect(amountToWei("0.000001", 18)).toBe("1000000000000");
  });

  it("returns 0 for invalid amounts", () => {
    expect(amountToWei("abc", 18)).toBe("0");
  });
});

describe("convertGraphToTxHashGroups", () => {
  it("converts native transfers to NormalTx", () => {
    const transfers: GraphTokenTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: null,
        amount: "1.5",
        transaction_id: "0xhash1",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 100,
        token_type: "native",
        token_symbol: "ETH",
        token_name: "Ether",
        token_decimals: 18,
      },
    ];

    const groups = convertGraphToTxHashGroups(transfers, [], 18);
    expect(groups).toHaveLength(1);
    expect(groups[0].hash).toBe("0xhash1");
    expect(groups[0].normal).not.toBeNull();
    expect(groups[0].normal!.from).toBe("0xaaa");
    expect(groups[0].normal!.to).toBe("0xbbb");
    expect(groups[0].normal!.value).toBe("1500000000000000000");
    expect(groups[0].normal!.gasUsed).toBe("0");
    expect(groups[0].normal!.gasPrice).toBe("0");
    expect(groups[0].normal!.isError).toBe("0");
  });

  it("converts ERC-20 transfers", () => {
    const transfers: GraphTokenTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: "0xtoken",
        amount: "100.5",
        transaction_id: "0xhash2",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 200,
        token_type: "erc20",
        token_symbol: "USDC",
        token_name: "USD Coin",
        token_decimals: 6,
      },
    ];

    const groups = convertGraphToTxHashGroups(transfers, [], 18);
    expect(groups).toHaveLength(1);
    expect(groups[0].erc20s).toHaveLength(1);
    expect(groups[0].erc20s[0].tokenSymbol).toBe("USDC");
    expect(groups[0].erc20s[0].value).toBe("100500000");
    expect(groups[0].erc20s[0].tokenDecimal).toBe("6");
    expect(groups[0].erc20s[0].contractAddress).toBe("0xtoken");
  });

  it("converts ERC-721 NFT transfers", () => {
    const nftTransfers: GraphNftTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: "0xnft",
        token_id: "42",
        amount: "1",
        transaction_id: "0xhash3",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 300,
        token_type: "erc721",
        token_symbol: "BAYC",
        token_name: "Bored Ape",
      },
    ];

    const groups = convertGraphToTxHashGroups([], nftTransfers, 18);
    expect(groups).toHaveLength(1);
    expect(groups[0].erc721s).toHaveLength(1);
    expect(groups[0].erc721s[0].tokenSymbol).toBe("BAYC");
    expect(groups[0].erc721s[0].tokenID).toBe("42");
    expect(groups[0].erc721s[0].contractAddress).toBe("0xnft");
  });

  it("converts ERC-1155 NFT transfers", () => {
    const nftTransfers: GraphNftTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: "0xnft1155",
        token_id: "7",
        amount: "5",
        transaction_id: "0xhash4",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 400,
        token_type: "erc1155",
        token_symbol: "ITEM",
        token_name: "Game Item",
      },
    ];

    const groups = convertGraphToTxHashGroups([], nftTransfers, 18);
    expect(groups).toHaveLength(1);
    expect(groups[0].erc1155s).toHaveLength(1);
    expect(groups[0].erc1155s[0].tokenSymbol).toBe("ITEM");
    expect(groups[0].erc1155s[0].tokenID).toBe("7");
    expect(groups[0].erc1155s[0].tokenValue).toBe("5");
  });

  it("groups multiple transfers by transaction_id", () => {
    const transfers: GraphTokenTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: null,
        amount: "0.5",
        transaction_id: "0xsame",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 500,
        token_type: "native",
        token_symbol: "ETH",
        token_name: "Ether",
        token_decimals: 18,
      },
      {
        from_address: "0xaaa",
        to_address: "0xccc",
        token_address: "0xtoken",
        amount: "200",
        transaction_id: "0xsame",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 500,
        token_type: "erc20",
        token_symbol: "DAI",
        token_name: "Dai Stablecoin",
        token_decimals: 18,
      },
    ];

    const groups = convertGraphToTxHashGroups(transfers, [], 18);
    expect(groups).toHaveLength(1);
    expect(groups[0].hash).toBe("0xsame");
    expect(groups[0].normal).not.toBeNull();
    expect(groups[0].erc20s).toHaveLength(1);
  });

  it("handles empty inputs", () => {
    const groups = convertGraphToTxHashGroups([], [], 18);
    expect(groups).toHaveLength(0);
  });

  it("always has empty internals array", () => {
    const transfers: GraphTokenTransfer[] = [
      {
        from_address: "0xaaa",
        to_address: "0xbbb",
        token_address: null,
        amount: "1",
        transaction_id: "0xhash5",
        block_timestamp: "2024-01-15T12:00:00Z",
        block_number: 600,
        token_type: "native",
        token_symbol: "ETH",
        token_name: "Ether",
        token_decimals: 18,
      },
    ];

    const groups = convertGraphToTxHashGroups(transfers, [], 18);
    expect(groups[0].internals).toEqual([]);
  });
});
