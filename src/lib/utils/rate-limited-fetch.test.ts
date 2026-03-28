import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimitedFetcher } from "./rate-limited-fetch";

function mockResponse(status = 200, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** Flush microtask queue so awaited promises inside execute() settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("RateLimitedFetcher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(mockResponse(200));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves immediately when tokens are available", async () => {
    const fetcher = new RateLimitedFetcher({ maxRequests: 5, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");
    await flushMicrotasks();

    const resp = await promise;
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com", undefined);
    fetcher.dispose();
  });

  it("passes init options through to fetch", async () => {
    const fetcher = new RateLimitedFetcher({ maxRequests: 5, intervalMs: 1000 });
    const init = { method: "POST", body: "data" };
    const promise = fetcher.fetch("https://example.com", init);
    await flushMicrotasks();

    await promise;
    expect(fetchMock).toHaveBeenCalledWith("https://example.com", init);
    fetcher.dispose();
  });

  it("queues requests when tokens are exhausted and drains on replenish", async () => {
    const fetcher = new RateLimitedFetcher({ maxRequests: 2, intervalMs: 1000 });

    // Use all 2 tokens
    const p1 = fetcher.fetch("https://example.com/1");
    const p2 = fetcher.fetch("https://example.com/2");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third request should be queued (no tokens left)
    const p3 = fetcher.fetch("https://example.com/3");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Replenish interval = 1000/2 = 500ms — advance to trigger replenish
    vi.advanceTimersByTime(500);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith("https://example.com/3", undefined);

    await Promise.all([p1, p2, p3]);
    fetcher.dispose();
  });

  it("retries 429 responses up to MAX_RETRIES (3) times", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(200));

    const fetcher = new RateLimitedFetcher({ maxRequests: 10, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");

    // Each 429 retry waits DEFAULT_RETRY_MS (5000ms)
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();
    }

    const resp = await promise;
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetcher.dispose();
  });

  it("uses Retry-After header value for wait duration", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(mockResponse(200));

    const fetcher = new RateLimitedFetcher({ maxRequests: 10, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");
    await flushMicrotasks();

    // Retry-After: 2 => 2000ms wait
    vi.advanceTimersByTime(1999);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    const resp = await promise;
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetcher.dispose();
  });

  it("resolves with 429 response after MAX_RETRIES exhausted", async () => {
    fetchMock.mockResolvedValue(mockResponse(429));

    const fetcher = new RateLimitedFetcher({ maxRequests: 10, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");

    // 3 retries, each waiting 5000ms
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();
    }

    // 4th call (retries=3 === MAX_RETRIES) should resolve with 429 instead of retrying
    await flushMicrotasks();
    const resp = await promise;
    expect(resp.status).toBe(429);
    // 1 initial + 3 retries = 4 calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetcher.dispose();
  });

  it("rejects promise on network error", async () => {
    const error = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(error);

    const fetcher = new RateLimitedFetcher({ maxRequests: 5, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");
    await flushMicrotasks();

    await expect(promise).rejects.toThrow("Failed to fetch");
    fetcher.dispose();
  });

  it("dispose() rejects all queued requests", async () => {
    const fetcher = new RateLimitedFetcher({ maxRequests: 1, intervalMs: 1000 });

    // Consume the single token
    const p1 = fetcher.fetch("https://example.com/1");
    await flushMicrotasks();

    // These will be queued (no tokens)
    const p2 = fetcher.fetch("https://example.com/2");
    const p3 = fetcher.fetch("https://example.com/3");

    fetcher.dispose();

    await expect(p2).rejects.toThrow("RateLimitedFetcher disposed");
    await expect(p3).rejects.toThrow("RateLimitedFetcher disposed");

    // p1 was already executing, should still resolve
    await expect(p1).resolves.toBeDefined();
  });

  it("fetch() after dispose() throws immediately", async () => {
    const fetcher = new RateLimitedFetcher({ maxRequests: 5, intervalMs: 1000 });
    fetcher.dispose();

    await expect(fetcher.fetch("https://example.com")).rejects.toThrow(
      "RateLimitedFetcher has been disposed",
    );
  });

  it("dispose() clears the interval timer", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const fetcher = new RateLimitedFetcher({ maxRequests: 5, intervalMs: 1000 });
    fetcher.dispose();

    expect(clearSpy).toHaveBeenCalledTimes(1);

    // Second dispose should not call clearInterval again (timer is already null)
    fetcher.dispose();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to DEFAULT_RETRY_MS when Retry-After is non-numeric", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, { "Retry-After": "invalid" }))
      .mockResolvedValueOnce(mockResponse(200));

    const fetcher = new RateLimitedFetcher({ maxRequests: 10, intervalMs: 1000 });
    const promise = fetcher.fetch("https://example.com");
    await flushMicrotasks();

    // Should fall back to 5000ms
    vi.advanceTimersByTime(4999);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    const resp = await promise;
    expect(resp.status).toBe(200);
    fetcher.dispose();
  });
});
