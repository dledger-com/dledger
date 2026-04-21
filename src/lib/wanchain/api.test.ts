import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetRateLimiter, addressTopic, TRANSFER_TOPIC0, WanchainClient } from "./api.js";

vi.mock("../cex/fetch.js", () => ({
  cexFetch: vi.fn(),
  abortableDelay: vi.fn().mockResolvedValue(undefined),
}));

import { cexFetch } from "../cex/fetch.js";

const mockedFetch = vi.mocked(cexFetch);

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimiter();
});

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

describe("addressTopic", () => {
  it("left-pads to 32 bytes and lowercases", () => {
    const t = addressTopic(ADDR);
    expect(t).toBe(
      "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678",
    );
    expect(t).toHaveLength(66);
  });
});

describe("WanchainClient.getLatestBlock", () => {
  it("decodes hex block number", async () => {
    mockedFetch.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x123456" }),
    });
    const client = new WanchainClient();
    const n = await client.getLatestBlock();
    expect(n).toBe(0x123456);
  });
});

describe("WanchainClient.getErc20Transfers", () => {
  it("queries both outgoing and incoming per chunk and decodes logs", async () => {
    const outLog = {
      address: "0xAaAa000000000000000000000000000000000001",
      transactionHash: "0xabc",
      blockNumber: "0x64",
      logIndex: "0x0",
      topics: [
        TRANSFER_TOPIC0,
        addressTopic(ADDR),
        addressTopic("0xcafe000000000000000000000000000000000002"),
      ],
      data: "0x" + (1000000n).toString(16).padStart(64, "0"),
    };
    const inLog = {
      address: "0xAaAa000000000000000000000000000000000001",
      transactionHash: "0xdef",
      blockNumber: "0x65",
      logIndex: "0x1",
      topics: [
        TRANSFER_TOPIC0,
        addressTopic("0xbeef000000000000000000000000000000000003"),
        addressTopic(ADDR),
      ],
      data: "0x" + (2000000n).toString(16).padStart(64, "0"),
    };

    mockedFetch
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [outLog] }) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [inLog] }) });

    const client = new WanchainClient({ logChunkSize: 10000 });
    const transfers = await client.getErc20Transfers(ADDR, 100, 200);

    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      contract: "0xaaaa000000000000000000000000000000000001",
      from: ADDR,
      to: "0xcafe000000000000000000000000000000000002",
      value: "1000000",
      blockNumber: 100,
    });
    expect(transfers[1]).toMatchObject({
      contract: "0xaaaa000000000000000000000000000000000001",
      from: "0xbeef000000000000000000000000000000000003",
      to: ADDR,
      value: "2000000",
      blockNumber: 101,
    });
  });

  it("chunks eth_getLogs calls by logChunkSize", async () => {
    mockedFetch.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
    });

    const client = new WanchainClient({ logChunkSize: 10 });
    await client.getErc20Transfers(ADDR, 0, 24); // 3 chunks: [0-9], [10-19], [20-24]

    // Each chunk → 2 calls (outgoing + incoming) = 6 total
    expect(mockedFetch).toHaveBeenCalledTimes(6);
  });

  it("retries RPC on HTTP 500", async () => {
    mockedFetch
      .mockResolvedValueOnce({ status: 500, body: "boom" })
      .mockResolvedValue({
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
      });
    const client = new WanchainClient({ logChunkSize: 10000 });
    const result = await client.getErc20Transfers(ADDR, 1, 2);
    expect(result).toEqual([]);
  });
});

describe("WanchainClient.mode", () => {
  it("reports tokenview when an API key is provided", () => {
    const c = new WanchainClient({ tokenviewApiKey: "abc" });
    expect(c.mode).toBe("tokenview");
  });
  it("reports rpc when no API key", () => {
    const c = new WanchainClient();
    expect(c.mode).toBe("rpc");
  });
  it("treats whitespace-only keys as no key", () => {
    const c = new WanchainClient({ tokenviewApiKey: "   " });
    expect(c.mode).toBe("rpc");
  });
});
