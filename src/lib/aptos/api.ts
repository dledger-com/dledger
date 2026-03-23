// Aptos API client — REST + Indexer GraphQL.
// REST: https://api.mainnet.aptoslabs.com/v1
// Indexer: https://api.mainnet.aptoslabs.com/v1/graphql

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { AptosActivity } from "./types.js";

const APTOS_BASE_URL = "https://api.mainnet.aptoslabs.com";
const APTOS_PROXY_PREFIX = "/api/aptos";
const RATE_LIMIT_MS = 100;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function aptosIndexerQuery<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${APTOS_BASE_URL}/v1/graphql`;
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, APTOS_BASE_URL, APTOS_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			const json = JSON.parse(res.body);
			if (json.errors) throw new Error(`Aptos Indexer error: ${JSON.stringify(json.errors[0]?.message ?? json.errors)}`);
			return json.data as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Aptos API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Aptos API: max retries exceeded");
}

const ACTIVITIES_QUERY = `
query ($address: String!, $limit: Int!, $offset: Int!, $minVersion: bigint) {
  fungible_asset_activities(
    where: {
      owner_address: {_eq: $address},
      is_transaction_success: {_eq: true},
      transaction_version: {_gt: $minVersion}
    },
    order_by: {transaction_version: asc},
    limit: $limit,
    offset: $offset
  ) {
    transaction_version
    event_index
    block_height
    transaction_timestamp
    type
    amount
    asset_type
    owner_address
    entry_function_id_str
    is_gas_fee
    is_transaction_success
  }
}`;

/**
 * Fetch fungible asset activities for an Aptos address, paginated.
 */
export async function fetchActivities(
	address: string,
	minVersion?: number,
	signal?: AbortSignal,
): Promise<AptosActivity[]> {
	const all: AptosActivity[] = [];
	let offset = 0;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data = await aptosIndexerQuery<{ fungible_asset_activities: AptosActivity[] }>(
			ACTIVITIES_QUERY,
			{ address, limit: PAGE_SIZE, offset, minVersion: minVersion ?? 0 },
			signal,
		);

		const page = data.fungible_asset_activities;
		all.push(...page);

		if (page.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
	}

	return all;
}
