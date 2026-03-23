// Tezos API client — TzKT REST API.
// Endpoint: https://api.tzkt.io/v1 — no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { TezosOperation, TezosTokenTransfer } from "./types.js";

const TZKT_BASE_URL = "https://api.tzkt.io";
const TZKT_PROXY_PREFIX = "/api/tezos";
const RATE_LIMIT_MS = 100;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function tzktGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${TZKT_BASE_URL}${path}`;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, TZKT_BASE_URL, TZKT_PROXY_PREFIX, undefined, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`TzKT API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("TzKT API: max retries exceeded");
}

/**
 * Fetch XTZ transaction operations for a Tezos address, paginated by cursor.
 */
export async function fetchOperations(
	address: string,
	lastId?: number,
	signal?: AbortSignal,
): Promise<TezosOperation[]> {
	const all: TezosOperation[] = [];
	let cursor = lastId ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const params = new URLSearchParams({
			type: "transaction",
			limit: String(PAGE_SIZE),
			status: "applied",
			"sort.asc": "id",
			"offset.cr": String(cursor),
		});

		const page = await tzktGet<TezosOperation[]>(
			`/v1/accounts/${address}/operations?${params.toString()}`,
			signal,
		);

		all.push(...page);

		if (page.length < PAGE_SIZE) break;
		cursor = page[page.length - 1].id;
	}

	return all;
}

/**
 * Fetch FA1.2/FA2 token transfers for a Tezos address, paginated by cursor.
 */
export async function fetchTokenTransfers(
	address: string,
	lastId?: number,
	signal?: AbortSignal,
): Promise<TezosTokenTransfer[]> {
	const all: TezosTokenTransfer[] = [];
	let cursor = lastId ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const params = new URLSearchParams({
			account: address,
			limit: String(PAGE_SIZE),
			"sort.asc": "id",
			"offset.cr": String(cursor),
		});

		const page = await tzktGet<TezosTokenTransfer[]>(
			`/v1/tokens/transfers?${params.toString()}`,
			signal,
		);

		all.push(...page);

		if (page.length < PAGE_SIZE) break;
		cursor = page[page.length - 1].id;
	}

	return all;
}
