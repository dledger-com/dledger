// Cardano Blockfrost API client.
// Docs: https://docs.blockfrost.io/

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { BlockfrostAddressTx, BlockfrostUtxos, BlockfrostTxInfo } from "./types.js";

const BLOCKFROST_BASE_URL = "https://cardano-mainnet.blockfrost.io/api/v0";
const BLOCKFROST_PROXY_PREFIX = "/api/cardano";
const RATE_LIMIT_MS = 100; // Blockfrost free tier: 10 req/s
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 100;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function blockfrostGet<T>(path: string, apiKey: string, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${BLOCKFROST_BASE_URL}${path}`;
	const init: RequestInit = {
		method: "GET",
		headers: { "Accept": "application/json", "project_id": apiKey },
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, BLOCKFROST_BASE_URL, BLOCKFROST_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			return JSON.parse(res.body) as T;
		}
		if (res.status === 404) {
			// 404 = address has no transactions yet
			return [] as unknown as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Blockfrost API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Blockfrost API: max retries exceeded");
}

/**
 * Fetch all transactions for a Cardano address, paginated.
 */
export async function fetchAddressTransactions(
	address: string,
	apiKey: string,
	startPage?: number,
	signal?: AbortSignal,
): Promise<{ transactions: BlockfrostAddressTx[]; nextPage: number | null }> {
	const allTxs: BlockfrostAddressTx[] = [];
	let page = startPage ?? 1;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const path = `/addresses/${address}/transactions?count=${PAGE_SIZE}&page=${page}&order=asc`;
		const data = await blockfrostGet<BlockfrostAddressTx[]>(path, apiKey, signal);

		if (!Array.isArray(data) || data.length === 0) {
			return { transactions: allTxs, nextPage: allTxs.length > 0 ? page : null };
		}

		allTxs.push(...data);

		if (data.length < PAGE_SIZE) {
			return { transactions: allTxs, nextPage: page + 1 };
		}

		page++;
	}
}

/**
 * Fetch UTXO details for a specific transaction.
 */
export async function fetchTxUtxos(
	txHash: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<BlockfrostUtxos> {
	return blockfrostGet<BlockfrostUtxos>(`/txs/${txHash}/utxos`, apiKey, signal);
}

/**
 * Fetch basic transaction info (for fee data).
 */
export async function fetchTxInfo(
	txHash: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<BlockfrostTxInfo> {
	return blockfrostGet<BlockfrostTxInfo>(`/txs/${txHash}`, apiKey, signal);
}
