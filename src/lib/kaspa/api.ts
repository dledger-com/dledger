// Kaspa API client — Kaspa REST API.
// Docs: https://api.kaspa.org

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { KaspaTransaction } from "./types.js";

const KASPA_BASE_URL = "https://api.kaspa.org";
const KASPA_PROXY_PREFIX = "/api/kaspa";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function kaspaGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${KASPA_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, KASPA_BASE_URL, KASPA_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Kaspa API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Kaspa API: max retries exceeded");
}

/**
 * Fetch full transactions for a Kaspa address, paginated.
 */
export async function fetchTransactions(
	address: string,
	afterTxId?: string,
	signal?: AbortSignal,
): Promise<{ transactions: KaspaTransaction[]; cursor: string | null }> {
	const allTxs: KaspaTransaction[] = [];

	let path = `/addresses/${encodeURIComponent(address)}/full-transactions?limit=${PAGE_SIZE}&resolve_previous_outpoints=light`;
	if (afterTxId) path += `&after=${encodeURIComponent(afterTxId)}`;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data = await kaspaGet<KaspaTransaction[]>(path, signal);
		allTxs.push(...data);

		if (data.length < PAGE_SIZE) {
			const lastId = data.length > 0 ? data[data.length - 1].transaction_id : null;
			return { transactions: allTxs, cursor: lastId };
		}

		const lastId = data[data.length - 1].transaction_id;
		path = `/addresses/${encodeURIComponent(address)}/full-transactions?limit=${PAGE_SIZE}&resolve_previous_outpoints=light&after=${encodeURIComponent(lastId)}`;
	}
}
