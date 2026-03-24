// Stacks API client — Hiro REST API.
// Docs: https://docs.hiro.so/stacks/api

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { StacksTransaction, StacksTransactionListResponse } from "./types.js";

const HIRO_BASE_URL = "https://api.hiro.so";
const HIRO_PROXY_PREFIX = "/api/stacks";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function hiroGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${HIRO_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, HIRO_BASE_URL, HIRO_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Hiro API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Hiro API: max retries exceeded");
}

/**
 * Fetch transactions for a Stacks address, paginated via offset.
 */
export async function fetchTransactions(
	address: string,
	startOffset?: number,
	signal?: AbortSignal,
): Promise<{ transactions: StacksTransaction[]; nextOffset: number | null }> {
	const allTxs: StacksTransaction[] = [];
	let offset = startOffset ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const path = `/extended/v1/address/${encodeURIComponent(address)}/transactions?limit=${PAGE_SIZE}&offset=${offset}`;
		const data = await hiroGet<StacksTransactionListResponse>(path, signal);
		allTxs.push(...data.results);

		if (data.results.length < PAGE_SIZE || offset + data.results.length >= data.total) {
			const nextOff = offset + data.results.length < data.total ? offset + data.results.length : null;
			return { transactions: allTxs, nextOffset: nextOff };
		}

		offset += data.results.length;
	}
}
