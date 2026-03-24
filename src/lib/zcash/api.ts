// Zcash API client — Blockchair REST API (transparent addresses only).
// Docs: https://blockchair.com/api/docs

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { BlockchairZcashResponse, BlockchairZcashTransaction } from "./types.js";

const BLOCKCHAIR_BASE_URL = "https://api.blockchair.com/zcash";
const BLOCKCHAIR_PROXY_PREFIX = "/api/zcash";
const RATE_LIMIT_MS = 500; // free tier: 2 req/s
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function blockchairGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${BLOCKCHAIR_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, BLOCKCHAIR_BASE_URL, BLOCKCHAIR_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Blockchair API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Blockchair API: max retries exceeded");
}

/**
 * Fetch transaction details for a Zcash transparent address.
 * Blockchair returns all transactions in a single dashboard call.
 */
export async function fetchTransactions(
	address: string,
	signal?: AbortSignal,
): Promise<{ transactions: BlockchairZcashTransaction[] }> {
	const data = await blockchairGet<BlockchairZcashResponse>(
		`/dashboards/address/${encodeURIComponent(address)}?transaction_details=true`,
		signal,
	);

	const addrData = data.data[address];
	if (!addrData) {
		return { transactions: [] };
	}

	return { transactions: addrData.transactions };
}
