// TronGrid API client.
// Endpoint: GET https://api.trongrid.io — public, no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { TronTransaction, TronTransactionListResponse } from "./types.js";

const TRON_BASE_URL = "https://api.trongrid.io";
const TRON_PROXY_PREFIX = "/api/tron";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function tronGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${TRON_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, TRON_BASE_URL, TRON_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			const json = JSON.parse(res.body);
			return json as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`TronGrid API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("TronGrid API: max retries exceeded");
}

/**
 * Fetch all transactions for a TRON address, paginated via fingerprint cursor.
 */
export async function fetchTransactions(
	address: string,
	fingerprint?: string,
	signal?: AbortSignal,
): Promise<{ transactions: TronTransaction[]; fingerprint: string | undefined }> {
	const allTxs: TronTransaction[] = [];
	let currentFingerprint: string | undefined = fingerprint;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let path = `/v1/accounts/${address}/transactions?limit=${PAGE_SIZE}`;
		if (currentFingerprint) path += `&fingerprint=${currentFingerprint}`;

		const data = await tronGet<TronTransactionListResponse>(path, signal);

		if (!data.success) {
			throw new Error("TronGrid API returned success=false");
		}

		allTxs.push(...data.data);

		if (!data.meta.fingerprint || data.data.length < PAGE_SIZE) {
			return { transactions: allTxs, fingerprint: data.meta.fingerprint };
		}
		currentFingerprint = data.meta.fingerprint;
	}
}
