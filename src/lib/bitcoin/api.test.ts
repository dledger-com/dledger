import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BtcApiTx } from "./types.js";
import { fetchAddressTxs, fetchAddressInfo, _resetRateLimiter } from "./api.js";

// cexFetch checks window.__TAURI_INTERNALS__; ensure window exists in Node
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = globalThis;
}

function makeMockTx(txid: string): BtcApiTx {
  return {
    txid,
    status: { confirmed: true, block_time: 1704067200, block_height: 800000 },
    vin: [{ txid: "prev", vout: 0, prevout: { scriptpubkey_address: "addr1", value: 50000 } }],
    vout: [{ scriptpubkey_address: "addr2", value: 49000, n: 0 }],
    fee: 1000,
  };
}

/** Mock a successful fetch response (cexFetch browser mode calls fetch then reads .status + .text()) */
function mockOk(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
    headers: new Headers(),
  };
}

function mock429(headers?: Record<string, string>) {
  return {
    ok: false,
    status: 429,
    text: () => Promise.resolve("Too Many Requests"),
    headers: new Headers(headers),
  };
}

function mock500() {
  return {
    ok: false,
    status: 500,
    text: () => Promise.resolve("Internal Server Error"),
    headers: new Headers(),
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
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockOk(txs));

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");

    expect(result).toHaveLength(10);
    expect(result[0].txid).toBe("tx0");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("paginates when receiving exactly 25 transactions", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => makeMockTx(`page1_tx${i}`));
    const page2 = Array.from({ length: 10 }, (_, i) => makeMockTx(`page2_tx${i}`));

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockOk(page1))
      .mockResolvedValueOnce(mockOk(page2));

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");

    expect(result).toHaveLength(35);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("handles empty response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockOk([]));

    const result = await fetchAddressTxs("bc1qtest", "https://mempool.test");
    expect(result).toHaveLength(0);
  });

  it("throws on 500 error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mock500());

    await expect(fetchAddressTxs("bc1qtest", "https://mempool.test")).rejects.toThrow(
      "Mempool API error 500",
    );
  });

  it("retries on 429 rate limit then succeeds", async () => {
    const txs = [makeMockTx("tx1")];
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mockOk(txs));

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test");
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all 429 retries", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValue(mock429());

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test")
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(300_000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Mempool API error 429");
  });

  it("aborts between retries when signal is aborted", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mock429());

    const promise = fetchAddressTxs("bc1qtest", "https://mempool.test", controller.signal)
      .catch((e: unknown) => e);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    const err = await promise;
    expect(err).toBeDefined();
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
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockOk({
      chain_stats: { tx_count: 10, funded_txo_sum: 500000, spent_txo_sum: 400000 },
      mempool_stats: { tx_count: 1, funded_txo_sum: 10000, spent_txo_sum: 0 },
    }));

    const info = await fetchAddressInfo("bc1qtest", "https://mempool.test");

    expect(info.tx_count).toBe(11);
    expect(info.funded_txo_sum).toBe(510000);
    expect(info.spent_txo_sum).toBe(400000);
  });

  it("handles missing stats gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockOk({}));

    const info = await fetchAddressInfo("bc1qtest", "https://mempool.test");

    expect(info.tx_count).toBe(0);
    expect(info.funded_txo_sum).toBe(0);
    expect(info.spent_txo_sum).toBe(0);
  });
});
