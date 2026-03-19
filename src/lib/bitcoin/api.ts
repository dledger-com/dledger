import type { BtcApiTx } from "./types.js";

const DEFAULT_BASE_URL = "https://mempool.space";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
  lastRequestTime = 0;
}

async function rateLimitedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    const res = await fetch(url, { signal });
    if (res.ok) return res;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) * 1000 : NaN;
      const waitMs = isNaN(parsed) ? BASE_RETRY_MS * 2 ** attempt : parsed;
      await new Promise(r => setTimeout(r, waitMs));
      lastRequestTime = Date.now();
      continue;
    }
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  throw new Error("Max retries exceeded");
}

/**
 * Fetch all transactions for a Bitcoin address with cursor-based pagination.
 * Mempool.space returns 25 txs per page, uses last txid as cursor.
 */
export async function fetchAddressTxs(
  address: string,
  baseUrl: string = DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<BtcApiTx[]> {
  const allTxs: BtcApiTx[] = [];
  let lastTxid: string | undefined;

  while (true) {
    const url = lastTxid
      ? `${baseUrl}/api/address/${address}/txs/chain/${lastTxid}`
      : `${baseUrl}/api/address/${address}/txs`;

    const res = await rateLimitedFetch(url, signal);
    const txs: BtcApiTx[] = await res.json();

    if (txs.length === 0) break;
    allTxs.push(...txs);

    if (txs.length < 25) break; // Last page
    lastTxid = txs[txs.length - 1].txid;
  }

  return allTxs;
}

/**
 * Quick check for address info (tx count).
 */
export async function fetchAddressInfo(
  address: string,
  baseUrl: string = DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<{ tx_count: number; funded_txo_sum: number; spent_txo_sum: number }> {
  const url = `${baseUrl}/api/address/${address}`;
  const res = await rateLimitedFetch(url, signal);
  const data = await res.json();

  // Mempool.space returns chain_stats and mempool_stats
  const chain = data.chain_stats || {};
  const mempool = data.mempool_stats || {};

  return {
    tx_count: (chain.tx_count || 0) + (mempool.tx_count || 0),
    funded_txo_sum: (chain.funded_txo_sum || 0) + (mempool.funded_txo_sum || 0),
    spent_txo_sum: (chain.spent_txo_sum || 0) + (mempool.spent_txo_sum || 0),
  };
}
