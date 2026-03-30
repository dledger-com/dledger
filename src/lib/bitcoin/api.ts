import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { BtcApiTx } from "./types.js";

const DEFAULT_BASE_URL = "https://mempool.space";
const MEMPOOL_PROXY_PREFIX = "/api/mempool";
const RATE_LIMIT_MS = 2000; // mempool.space public API: ~10 req/min
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 3000;

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
  lastRequestTime = 0;
}

async function mempoolGet(url: string, baseUrl: string, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
  lastRequestTime = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await cexFetch(url, baseUrl, MEMPOOL_PROXY_PREFIX, { method: "GET", headers: { Accept: "application/json" } }, signal);
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
      lastRequestTime = Date.now();
      continue;
    }
    throw new Error(`Mempool API error ${res.status}: ${res.body.slice(0, 500)}`);
  }
  throw new Error("Mempool API: max retries exceeded");
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

    const res = await mempoolGet(url, baseUrl, signal);
    const txs: BtcApiTx[] = JSON.parse(res.body);

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
  const res = await mempoolGet(url, baseUrl, signal);
  const data = JSON.parse(res.body);

  // Mempool.space returns chain_stats and mempool_stats
  const chain = data.chain_stats || {};
  const mempool = data.mempool_stats || {};

  return {
    tx_count: (chain.tx_count || 0) + (mempool.tx_count || 0),
    funded_txo_sum: (chain.funded_txo_sum || 0) + (mempool.funded_txo_sum || 0),
    spent_txo_sum: (chain.spent_txo_sum || 0) + (mempool.spent_txo_sum || 0),
  };
}
