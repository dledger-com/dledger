// XRP Ledger JSON-RPC API client.
// Endpoint: POST https://xrplcluster.com — public, no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { XrpAccountTxResponse, XrpTransaction } from "./types.js";

const XRP_RPC_URL = "https://xrplcluster.com";
const XRP_PROXY_PREFIX = "/api/xrp";
const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function xrpRpc<T>(method: string, params: Record<string, unknown>[], signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ method, params }),
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(XRP_RPC_URL, XRP_RPC_URL, XRP_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			const json = JSON.parse(res.body);
			if (json.result?.status === "error") {
				throw new Error(`XRPL error: ${json.result.error_message ?? json.result.error}`);
			}
			return json as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`XRP API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("XRP API: max retries exceeded");
}

/**
 * Fetch all transactions for an XRP address, paginated via marker.
 */
export async function fetchTransactions(
	address: string,
	marker?: string,
	signal?: AbortSignal,
): Promise<{ transactions: Array<{ tx: XrpTransaction; validated: boolean }>; marker: string | undefined }> {
	const allTxs: Array<{ tx: XrpTransaction; validated: boolean }> = [];
	let currentMarker: string | undefined = marker;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const params: Record<string, unknown> = {
			account: address,
			limit: PAGE_SIZE,
			forward: true,
		};
		if (currentMarker) params.marker = currentMarker;

		const data = await xrpRpc<XrpAccountTxResponse>("account_tx", [params], signal);

		const page = data.result.transactions;
		allTxs.push(...page);

		if (!data.result.marker || page.length < PAGE_SIZE) {
			return { transactions: allTxs, marker: data.result.marker };
		}
		currentMarker = data.result.marker;
	}
}
