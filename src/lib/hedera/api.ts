// Hedera API client — Mirror Node REST API.
// Docs: https://docs.hedera.com/hedera/sdks-and-apis/rest-api

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { HederaTransaction, HederaTransactionListResponse } from "./types.js";

const HEDERA_BASE_URL = "https://mainnet-public.mirrornode.hedera.com";
const HEDERA_PROXY_PREFIX = "/api/hedera";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function hederaGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${HEDERA_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, HEDERA_BASE_URL, HEDERA_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Hedera API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Hedera API: max retries exceeded");
}

/**
 * Fetch transactions for a Hedera account, paginated via consensus timestamp.
 */
export async function fetchTransactions(
	address: string,
	afterTimestamp?: string,
	signal?: AbortSignal,
): Promise<{ transactions: HederaTransaction[]; cursor: string | null }> {
	const allTxs: HederaTransaction[] = [];
	let nextPath: string | null = null;

	// Build initial path
	let path = `/api/v1/transactions?account.id=${encodeURIComponent(address)}&limit=${PAGE_SIZE}&order=asc`;
	if (afterTimestamp) path += `&timestamp=gt:${afterTimestamp}`;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data: HederaTransactionListResponse = await hederaGet<HederaTransactionListResponse>(nextPath ?? path, signal);
		allTxs.push(...data.transactions);

		if (!data.links.next) {
			const lastTs = data.transactions.length > 0
				? data.transactions[data.transactions.length - 1].consensus_timestamp
				: null;
			return { transactions: allTxs, cursor: lastTs };
		}

		nextPath = data.links.next;
	}
}
