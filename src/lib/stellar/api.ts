// Stellar Horizon API client.
// Endpoint: GET https://horizon.stellar.org — public, no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { StellarOperation, StellarOperationListResponse } from "./types.js";

const STELLAR_BASE_URL = "https://horizon.stellar.org";
const STELLAR_PROXY_PREFIX = "/api/stellar";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function stellarGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${STELLAR_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, STELLAR_BASE_URL, STELLAR_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Stellar API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Stellar API: max retries exceeded");
}

/**
 * Fetch all operations for a Stellar address, paginated via cursor.
 */
export async function fetchOperations(
	address: string,
	cursor?: string,
	signal?: AbortSignal,
): Promise<{ operations: StellarOperation[]; endCursor: string | undefined }> {
	const allOps: StellarOperation[] = [];
	let currentCursor: string | undefined = cursor;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let path = `/accounts/${address}/operations?limit=${PAGE_SIZE}&order=asc`;
		if (currentCursor) path += `&cursor=${currentCursor}`;

		const data = await stellarGet<StellarOperationListResponse>(path, signal);

		const page = data._embedded.records;
		allOps.push(...page);

		if (page.length < PAGE_SIZE) {
			const lastCursor = page.length > 0 ? page[page.length - 1].paging_token : currentCursor;
			return { operations: allOps, endCursor: lastCursor };
		}
		currentCursor = page[page.length - 1].paging_token;
	}
}
