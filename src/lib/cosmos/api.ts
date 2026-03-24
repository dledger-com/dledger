// Cosmos LCD API client.
// Endpoint: GET https://lcd-cosmoshub.keplr.app — no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { CosmosTxResponse } from "./types.js";

const COSMOS_BASE_URL = "https://lcd-cosmoshub.keplr.app";
const COSMOS_PROXY_PREFIX = "/api/cosmos";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function cosmosGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${COSMOS_BASE_URL}${path}`;
	const init: RequestInit = { method: "GET" };

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, COSMOS_BASE_URL, COSMOS_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Cosmos API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Cosmos API: max retries exceeded");
}

interface TxSearchResponse {
	tx_responses: CosmosTxResponse[];
	pagination: { total: string };
}

/**
 * Fetch transactions for a Cosmos address, querying both sender and recipient events
 * and merging/deduplicating by txhash.
 */
export async function fetchTransactions(
	address: string,
	offset?: number,
	signal?: AbortSignal,
): Promise<{ txs: CosmosTxResponse[]; total: number }> {
	const startOffset = offset ?? 0;
	const seen = new Map<string, CosmosTxResponse>();
	let total = 0;

	// Query 1: transactions where address is sender
	const senderPath = `/cosmos/tx/v1beta1/txs?events=message.sender%3D'${address}'&pagination.limit=${PAGE_SIZE}&pagination.offset=${startOffset}&order_by=ORDER_BY_DESC`;
	const senderData = await cosmosGet<TxSearchResponse>(senderPath, signal);
	total = Math.max(total, parseInt(senderData.pagination.total, 10) || 0);
	for (const tx of senderData.tx_responses) {
		seen.set(tx.txhash, tx);
	}

	// Query 2: transactions where address is recipient
	const recipientPath = `/cosmos/tx/v1beta1/txs?events=transfer.recipient%3D'${address}'&pagination.limit=${PAGE_SIZE}&pagination.offset=${startOffset}&order_by=ORDER_BY_DESC`;
	const recipientData = await cosmosGet<TxSearchResponse>(recipientPath, signal);
	total = Math.max(total, parseInt(recipientData.pagination.total, 10) || 0);
	for (const tx of recipientData.tx_responses) {
		if (!seen.has(tx.txhash)) {
			seen.set(tx.txhash, tx);
		}
	}

	return { txs: Array.from(seen.values()), total };
}
