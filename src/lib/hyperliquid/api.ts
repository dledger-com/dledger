// Hyperliquid Info API client.
// All endpoints are POST https://api.hyperliquid.xyz/info — no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type {
	HlFill,
	HlFundingDelta,
	HlLedgerUpdate,
	HlClearinghouseState,
	HlSpotClearinghouseState,
} from "./types.js";

const HL_BASE_URL = "https://api.hyperliquid.xyz";
const HL_PROXY_PREFIX = "/api/hyperliquid";
const RATE_LIMIT_MS = 50; // 1200 weight/min ≈ 20 req/s
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 2000; // Max per response

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
	lastRequestTime = 0;
}

async function hlFetch<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	// Rate limiting
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) {
		await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	}
	lastRequestTime = Date.now();

	const url = `${HL_BASE_URL}/info`;
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const res = await cexFetch(url, HL_BASE_URL, HL_PROXY_PREFIX, init, signal);

		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			const waitMs = BASE_RETRY_MS * 2 ** attempt;
			await abortableDelay(waitMs, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Hyperliquid API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Hyperliquid API: max retries exceeded");
}

/**
 * Fetch user trade fills, paginated by startTime.
 * Returns up to 10,000 total fills (API hard limit).
 */
export async function fetchUserFills(
	address: string,
	startTime?: number,
	signal?: AbortSignal,
): Promise<HlFill[]> {
	const allFills: HlFill[] = [];
	let cursor = startTime ?? 0;

	while (allFills.length < 10000) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const page = await hlFetch<HlFill[]>({
			type: "userFillsByTime",
			user: address,
			startTime: cursor,
			aggregateByTime: false,
		}, signal);

		if (page.length === 0) break;

		allFills.push(...page);

		if (page.length < PAGE_SIZE) break;

		// Next page starts after the latest timestamp in this page
		const maxTime = Math.max(...page.map(f => f.time));
		cursor = maxTime + 1;
	}

	return allFills;
}

/**
 * Fetch user funding payments, paginated by startTime.
 */
export async function fetchUserFunding(
	address: string,
	startTime?: number,
	signal?: AbortSignal,
): Promise<HlFundingDelta[]> {
	const allFunding: HlFundingDelta[] = [];
	let cursor = startTime ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const page = await hlFetch<HlFundingDelta[]>({
			type: "userFunding",
			user: address,
			startTime: cursor,
		}, signal);

		if (page.length === 0) break;

		allFunding.push(...page);

		if (page.length < PAGE_SIZE) break;

		const maxTime = Math.max(...page.map(f => f.time));
		cursor = maxTime + 1;
	}

	return allFunding;
}

/**
 * Fetch non-funding ledger updates (deposits, withdrawals, transfers, liquidations).
 */
export async function fetchUserLedgerUpdates(
	address: string,
	startTime?: number,
	signal?: AbortSignal,
): Promise<HlLedgerUpdate[]> {
	const allUpdates: HlLedgerUpdate[] = [];
	let cursor = startTime ?? 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const page = await hlFetch<HlLedgerUpdate[]>({
			type: "userNonFundingLedgerUpdates",
			user: address,
			startTime: cursor,
		}, signal);

		if (page.length === 0) break;

		allUpdates.push(...page);

		if (page.length < PAGE_SIZE) break;

		const maxTime = Math.max(...page.map(u => u.time));
		cursor = maxTime + 1;
	}

	return allUpdates;
}

/**
 * Fetch current perpetual positions and margin state (display only, weight 2).
 */
export async function fetchClearinghouseState(
	address: string,
	signal?: AbortSignal,
): Promise<HlClearinghouseState> {
	return hlFetch<HlClearinghouseState>({
		type: "clearinghouseState",
		user: address,
	}, signal);
}

/**
 * Fetch current spot balances (display only, weight 2).
 */
export async function fetchSpotState(
	address: string,
	signal?: AbortSignal,
): Promise<HlSpotClearinghouseState> {
	return hlFetch<HlSpotClearinghouseState>({
		type: "spotClearinghouseState",
		user: address,
	}, signal);
}
