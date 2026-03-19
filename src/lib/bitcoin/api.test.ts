import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BtcApiTx } from "./types.js";
import { fetchAddressTxs, fetchAddressInfo, _resetRateLimiter } from "./api.js";

function makeMockTx(txid: string): BtcApiTx {
  return {
    txid,
    status: { confirmed: true, block_time: 1704067200, block_height: 800000 },
    vin: [{ txid: "prev", vout: 0, prevout: { scriptpubkey_address: "addr1", value: 50000 } }],
    vout: [{ scriptpubkey_address: "addr2", value: 49000, n: 0 }],
    fee: 1000,
  };
}

function mock429(headers?: Record<string, string>) {
  return {
    ok: false,
    status: 429,
    headers: { get: (k: string) => headers?.[k] ?? null },
    text: () => Promise.resolve("Too Many Requests"),
  };
}

describe("fetchAddressTxs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetRateLimiter();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches a single page of transactions", async () => {
    const txs = Array.from({ length: 10 }, (_, i) => makeMockTx(`tx${i}`));
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(txs),
    });

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");

    expect(result).toHaveLength(10);
    expect(result[0].txid).toBe("tx0");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://mempool.test/api/address/bc1qtest/txs",
    );
  });

  it("paginates when receiving exactly 25 transactions", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => makeMockTx(`page1_tx${i}`));
    const page2 = Array.from({ length: 10 }, (_, i) => makeMockTx(`page2_tx${i}`));

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");

    expect(result).toHaveLength(35);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      "https://mempool.test/api/address/bc1qtest/txs/chain/page1_tx24",
    );
  });

  it("handles empty response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");
    expect(result).toHaveLength(0);
  });

  it("throws on 500 error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(fetchAddressTxs("bc1qtest", "https://mempool.test")).rejects.toThrow(
      "API error 500",
    );
  });

  it("retries up to 3 times on 429 rate limit", async () => {
    const txs = [makeMockTx("tx1")];
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(txs),
      });

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test");
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all 429 retries", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429());

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test")
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(20_000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("API error 429");
    // 1 initial attempt + 3 retries = 4 calls
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("respects Retry-After header on 429", async () => {
    const txs = [makeMockTx("tx1")];
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429({ "Retry-After": "5" }))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(txs),
      });

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test");
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts between retries when signal is aborted", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429());

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test", controller.signal)
      .catch((e: Error) => e);
    // Abort during the retry wait period
    controller.abort();
    // Advance past the retry wait so the loop continues and checks signal.aborted
    await vi.advanceTimersByTimeAsync(3_000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Aborted");
    // Only the initial fetch call, no retry after abort
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAddressInfo", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetRateLimiter();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns combined chain + mempool stats", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          chain_stats: { tx_count: 10, funded_txo_sum: 500000, spent_txo_sum: 400000 },
          mempool_stats: { tx_count: 1, funded_txo_sum: 10000, spent_txo_sum: 0 },
        }),
    });

    const info = await fetchAddressInfo("bc1qtest", "https://mempool.test");

    expect(info.tx_count).toBe(11);
    expect(info.funded_txo_sum).toBe(510000);
    expect(info.spent_txo_sum).toBe(400000);
  });

  it("handles missing stats gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const info = await fetchAddressInfo("bc1qtest", "https://mempool.test");

    expect(info.tx_count).toBe(0);
    expect(info.funded_txo_sum).toBe(0);
    expect(info.spent_txo_sum).toBe(0);
  });
});
