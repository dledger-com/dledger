// Algorand API client — AlgoNode Indexer REST API.
// Docs: https://developer.algorand.org/docs/rest-apis/indexer

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { AlgorandTransaction, AlgorandTransactionListResponse } from "./types.js";

const ALGONODE_BASE_URL = "https://mainnet-idx.algonode.cloud";
const ALGONODE_PROXY_PREFIX = "/api/algorand";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function algoGet<T>(path: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${ALGONODE_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json" },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, ALGONODE_BASE_URL, ALGONODE_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Algorand API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Algorand API: max retries exceeded");
}

/**
 * Fetch transactions for an Algorand address, paginated via next-token.
 */
export async function fetchTransactions(
	address: string,
	nextToken?: string,
	signal?: AbortSignal,
): Promise<{ transactions: AlgorandTransaction[]; nextToken: string | null }> {
	const allTxs: AlgorandTransaction[] = [];
	let currentToken = nextToken ?? null;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let path = `/v2/accounts/${encodeURIComponent(address)}/transactions?limit=${PAGE_SIZE}`;
		if (currentToken) path += `&next=${encodeURIComponent(currentToken)}`;

		const data = await algoGet<AlgorandTransactionListResponse>(path, signal);
		allTxs.push(...data.transactions);

		if (!data["next-token"] || data.transactions.length < PAGE_SIZE) {
			return { transactions: allTxs, nextToken: data["next-token"] ?? null };
		}

		currentToken = data["next-token"];
	}
}
