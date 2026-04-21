// Waves Node REST API client.
// Docs: https://docs.waves.tech/en/waves-node/node-api/
// Public pool: https://nodes.wavesnodes.com — free, no key, ~20 r/s burst 50.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { WavesAssetDetails, WavesTransaction } from "./types.js";

const WAVES_BASE_URL = "https://nodes.wavesnodes.com";
const WAVES_PROXY_PREFIX = "/api/waves";
const RATE_LIMIT_MS = 60;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
  lastRequestTime = 0;
}

async function wavesGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
  lastRequestTime = Date.now();

  const url = `${WAVES_BASE_URL}${path}`;
  const init: RequestInit = { method: "GET", headers: { Accept: "application/json" } };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await cexFetch(url, WAVES_BASE_URL, WAVES_PROXY_PREFIX, init, signal);
    if (res.status === 200) return JSON.parse(res.body) as T;
    if (res.status === 404) {
      throw new Error(`Waves API 404: ${path}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
      lastRequestTime = Date.now();
      continue;
    }
    throw new Error(`Waves API error ${res.status}: ${res.body.slice(0, 500)}`);
  }
  throw new Error("Waves API: max retries exceeded");
}

export class WavesClient {
  private assetCache = new Map<string, WavesAssetDetails>();

  /**
   * Fetch one page of transactions for an address, newest-first.
   * Waves wraps the array in a single-element outer array: `[[tx, tx, ...]]`.
   */
  async fetchTransactionsPage(
    address: string,
    after?: string | null,
    signal?: AbortSignal,
  ): Promise<WavesTransaction[]> {
    let path = `/transactions/address/${address}/limit/${PAGE_SIZE}`;
    if (after) path += `?after=${after}`;
    const raw = await wavesGet<WavesTransaction[][] | WavesTransaction[]>(path, signal);
    // Endpoint historically returns a nested array; newer nodes may return flat.
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
      return raw[0] as WavesTransaction[];
    }
    return raw as WavesTransaction[];
  }

  /**
   * Fetch all transactions newer than the cursor (last imported tx id).
   * Walks pages from present back until it hits the cursor or runs out.
   */
  async fetchNewTransactions(
    address: string,
    sinceId: string | null,
    signal?: AbortSignal,
    onProgress?: (count: number) => void,
  ): Promise<WavesTransaction[]> {
    const collected: WavesTransaction[] = [];
    let after: string | null = null;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await this.fetchTransactionsPage(address, after, signal);
      if (page.length === 0) break;

      for (const tx of page) {
        if (sinceId && tx.id === sinceId) {
          onProgress?.(collected.length);
          return collected;
        }
        collected.push(tx);
      }

      onProgress?.(collected.length);

      if (page.length < PAGE_SIZE) break;
      after = page[page.length - 1].id;
    }

    return collected;
  }

  /** Fetch asset metadata (decimals, name). Cached in-memory per instance. */
  async getAssetDetails(assetId: string, signal?: AbortSignal): Promise<WavesAssetDetails> {
    const cached = this.assetCache.get(assetId);
    if (cached) return cached;

    const details = await wavesGet<WavesAssetDetails>(
      `/assets/details/${assetId}`,
      signal,
    );
    this.assetCache.set(assetId, details);
    return details;
  }
}
