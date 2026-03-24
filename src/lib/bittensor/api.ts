// Bittensor API client — Subscan REST API (same pattern as Polkadot).
// Docs: https://support.subscan.io

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { BittensorTransfer, BittensorReward } from "./types.js";

const SUBSCAN_BASE_URL = "https://bittensor.api.subscan.io";
const SUBSCAN_PROXY_PREFIX = "/api/bittensor";
const RATE_LIMIT_MS = 200; // free tier: 5 req/s
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

interface SubscanResponse<T> {
	code: number;
	message: string;
	data: T;
}

async function subscanPost<T>(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${SUBSCAN_BASE_URL}${endpoint}`;
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, SUBSCAN_BASE_URL, SUBSCAN_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			const json = JSON.parse(res.body) as SubscanResponse<T>;
			if (json.code !== 0) throw new Error(`Subscan error ${json.code}: ${json.message}`);
			return json.data;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Subscan API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Subscan API: max retries exceeded");
}

/**
 * Fetch transfers for a Bittensor address, paginated.
 */
export async function fetchTransfers(
	address: string,
	page?: number,
	signal?: AbortSignal,
): Promise<BittensorTransfer[]> {
	const all: BittensorTransfer[] = [];
	let currentPage = page ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data = await subscanPost<{ count: number; transfers: BittensorTransfer[] | null }>(
			"/api/v2/scan/transfers",
			{ address, row: PAGE_SIZE, page: currentPage },
			signal,
		);

		const transfers = data.transfers ?? [];
		all.push(...transfers);

		if (transfers.length < PAGE_SIZE) break;
		currentPage++;
	}

	return all;
}

/**
 * Fetch staking rewards for a Bittensor address, paginated.
 */
export async function fetchRewards(
	address: string,
	page?: number,
	signal?: AbortSignal,
): Promise<BittensorReward[]> {
	const all: BittensorReward[] = [];
	let currentPage = page ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data = await subscanPost<{ count: number; list: BittensorReward[] | null }>(
			"/api/v2/scan/account/reward_slash",
			{ address, row: PAGE_SIZE, page: currentPage },
			signal,
		);

		const rewards = data.list ?? [];
		all.push(...rewards);

		if (rewards.length < PAGE_SIZE) break;
		currentPage++;
	}

	return all;
}
