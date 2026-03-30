// TON API client.
// Endpoint: GET https://tonapi.io/v2/accounts/{address}/events — no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { TonEvent } from "./types.js";

const TON_BASE_URL = "https://tonapi.io";
const TON_PROXY_PREFIX = "/api/ton";
const RATE_LIMIT_MS = 1000; // TonAPI free tier: ~1 req/s
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 3000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function tonGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${TON_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, TON_BASE_URL, TON_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`TON API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("TON API: max retries exceeded");
}

/**
 * Fetch events for a TON address, paginated via logical time cursor.
 * Returns all events and the cursor (minimum lt) for the next page.
 */
export async function fetchEvents(
	address: string,
	beforeLt?: string,
	signal?: AbortSignal,
): Promise<{ events: TonEvent[]; cursor: string | null }> {
	const allEvents: TonEvent[] = [];
	let cursor = beforeLt ?? null;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let path = `/v2/accounts/${encodeURIComponent(address)}/events?limit=${PAGE_SIZE}`;
		if (cursor) path += `&before_lt=${cursor}`;

		const data = await tonGet<{ events: TonEvent[] }>(path, signal);
		const page = data.events;
		allEvents.push(...page);

		if (page.length < PAGE_SIZE) {
			// Last page — no more events
			const lastLt = page.length > 0 ? String(Math.min(...page.map(e => e.lt))) : null;
			return { events: allEvents, cursor: lastLt };
		}

		// Next page: use minimum lt from this page
		cursor = String(Math.min(...page.map(e => e.lt)));
	}
}
