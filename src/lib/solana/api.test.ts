import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchTransactionHistory, _resetRateLimiter } from "./api.js";

beforeEach(() => {
  _resetRateLimiter();
  vi.restoreAllMocks();
});

describe("fetchTransactionHistory", () => {
  it("fetches transactions and returns them", async () => {
    const mockTxs = [
      {
        signature: "sig1",
        timestamp: 1700000000,
        slot: 100,
        fee: 5000,
        feePayer: "addr1",
        status: "success",
        nativeTransfers: [],
        tokenTransfers: [],
        instructions: [],
      },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockTxs),
    }));

    const result = await fetchTransactionHistory("addr1", "test-api-key");
    expect(result).toHaveLength(1);
    expect(result[0].signature).toBe("sig1");

    const fetchCall = (fetch as any).mock.calls[0][0] as string;
    expect(fetchCall).toContain("api.helius.xyz");
    expect(fetchCall).toContain("api-key=test-api-key");
    expect(fetchCall).toContain("addr1");
  });

  it("stops at lastSignature", async () => {
    const mockTxs = [
      { signature: "sig2", timestamp: 1700000001, slot: 101, fee: 5000, feePayer: "addr1", status: "success", nativeTransfers: [], tokenTransfers: [], instructions: [] },
      { signature: "sig1", timestamp: 1700000000, slot: 100, fee: 5000, feePayer: "addr1", status: "success", nativeTransfers: [], tokenTransfers: [], instructions: [] },
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockTxs),
    }));

    const result = await fetchTransactionHistory("addr1", "test-api-key", {
      lastSignature: "sig1",
    });
    // Should stop before sig1
    expect(result).toHaveLength(1);
    expect(result[0].signature).toBe("sig2");
  });

  it("paginates using before parameter", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      signature: `sig${i}`,
      timestamp: 1700000000 - i,
      slot: 1000 - i,
      fee: 5000,
      feePayer: "addr1",
      status: "success",
      nativeTransfers: [],
      tokenTransfers: [],
      instructions: [],
    }));
    const page2 = [
      { signature: "sig100", timestamp: 1699999900, slot: 900, fee: 5000, feePayer: "addr1", status: "success", nativeTransfers: [], tokenTransfers: [], instructions: [] },
    ];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(callCount === 1 ? page1 : page2),
      });
    }));

    const result = await fetchTransactionHistory("addr1", "test-api-key");
    expect(result).toHaveLength(101);
    expect(callCount).toBe(2);

    // Second call should include before=sig99
    const secondCallUrl = (fetch as any).mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("before=sig99");
  });

  it("throws on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    await expect(fetchTransactionHistory("addr1", "key")).rejects.toThrow("Helius API error 500");
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Aborted")));

    await expect(
      fetchTransactionHistory("addr1", "key", { signal: controller.signal }),
    ).rejects.toThrow("Aborted");
  });
});
