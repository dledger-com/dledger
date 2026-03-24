// NEAR API client — NEAR Blocks REST API.
// Docs: https://api.nearblocks.io/api-docs

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { NearTransaction } from "./types.js";

const NEAR_BASE_URL = "https://api.nearblocks.io";
const NEAR_PROXY_PREFIX = "/api/near";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function nearGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${NEAR_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, NEAR_BASE_URL, NEAR_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`NEAR API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("NEAR API: max retries exceeded");
}

/**
 * Fetch transactions for a NEAR account, paginated via cursor.
 */
export async function fetchTransactions(
	address: string,
	cursor?: string,
	signal?: AbortSignal,
): Promise<{ txns: NearTransaction[]; cursor: string | null }> {
	const allTxns: NearTransaction[] = [];
	let currentCursor = cursor ?? null;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let path = `/v1/account/${encodeURIComponent(address)}/txns?per_page=${PAGE_SIZE}&order=asc`;
		if (currentCursor) path += `&cursor=${encodeURIComponent(currentCursor)}`;

		const data = await nearGet<{ txns: NearTransaction[]; cursor: string | null }>(path, signal);
		allTxns.push(...data.txns);

		if (!data.cursor || data.txns.length < PAGE_SIZE) {
			return { txns: allTxns, cursor: data.cursor };
		}

		currentCursor = data.cursor;
	}
}
