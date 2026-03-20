import type { SolTxGroup } from "./types.js";

const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
  lastRequestTime = 0;
}

async function rateLimitedFetch(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    const res = await fetch(url, { headers, signal });
    if (res.ok) return res;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) * 1000 : NaN;
      const waitMs = isNaN(parsed) ? BASE_RETRY_MS * 2 ** attempt : parsed;
      await new Promise(r => setTimeout(r, waitMs));
      lastRequestTime = Date.now();
      continue;
    }
    throw new Error(`Helius API error ${res.status}: ${await res.text()}`);
  }
  throw new Error("Max retries exceeded");
}

/**
 * Fetch transaction history for a Solana address using Helius Enhanced Transactions API.
 * Supports incremental sync via `lastSignature` (will stop when reaching it).
 */
export async function fetchTransactionHistory(
  address: string,
  apiKey: string,
  options?: {
    lastSignature?: string;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<SolTxGroup[]> {
  const allTxs: SolTxGroup[] = [];
  let beforeSignature: string | undefined;
  const pageLimit = 100; // Helius max per request
  const maxTotal = options?.limit ?? 10000;

  while (allTxs.length < maxTotal) {
    if (options?.signal?.aborted) throw new Error("Aborted");

    let url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=${pageLimit}`;
    if (beforeSignature) {
      url += `&before=${beforeSignature}`;
    }

    const res = await rateLimitedFetch(url, undefined, options?.signal);
    const txs: SolTxGroup[] = await res.json();

    if (txs.length === 0) break;

    // Check if we've reached the stopping point
    for (const tx of txs) {
      if (options?.lastSignature && tx.signature === options.lastSignature) {
        return allTxs; // Stop at the last known signature
      }
      allTxs.push(tx);
    }

    if (txs.length < pageLimit) break; // Last page
    beforeSignature = txs[txs.length - 1].signature;
  }

  return allTxs;
}

/**
 * Fetch token accounts for a Solana address.
 */
export async function fetchTokenAccounts(
  address: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Array<{ mint: string; amount: string; decimals: number; tokenSymbol?: string }>> {
  const url = `https://api.helius.xyz/v0/addresses/${address}/balances?api-key=${apiKey}`;
  const res = await rateLimitedFetch(url, undefined, signal);
  const data = await res.json();

  if (!data.tokens || !Array.isArray(data.tokens)) return [];

  return data.tokens.map((t: { mint: string; amount: number; decimals: number; tokenSymbol?: string }) => ({
    mint: t.mint,
    amount: String(t.amount),
    decimals: t.decimals,
    tokenSymbol: t.tokenSymbol,
  }));
}
