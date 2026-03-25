// Monero Light Wallet Server (LWS) API client.
// Compatible with MyMonero LWS protocol.
// User must provide their own LWS URL — no default endpoint for privacy.

import { abortableDelay } from "../cex/fetch.js";
import type { LwsAddressTxsResponse } from "./types.js";

const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function lwsPost<T>(lwsUrl: string, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${lwsUrl.replace(/\/+$/, "")}${path}`;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		// Use direct fetch for LWS (user-configured URL, not a fixed base)
		// In Tauri mode, this goes through proxy_fetch; in browser mode, direct fetch
		let res: Response;
		if ((window as any).__TAURI_INTERNALS__) {
			const { invoke } = await import("@tauri-apps/api/core");
			const result = await invoke<{ status: number; body: string }>("proxy_fetch", {
				url,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (result.status === 200) return JSON.parse(result.body) as T;
			if (result.status === 429 && attempt < MAX_RETRIES) {
				await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
				lastRequestTime = Date.now();
				continue;
			}
			throw new Error(`Monero LWS error ${result.status}: ${result.body.slice(0, 500)}`);
		} else {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});
			if (res.ok) return await res.json() as T;
			if (res.status === 429 && attempt < MAX_RETRIES) {
				await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
				lastRequestTime = Date.now();
				continue;
			}
			throw new Error(`Monero LWS error ${res.status}: ${await res.text().then(t => t.slice(0, 500))}`);
		}
	}
	throw new Error("Monero LWS: max retries exceeded");
}

/**
 * Register an address + view key with the LWS.
 * Must be called before fetching transactions.
 */
export async function lwsLogin(
	lwsUrl: string,
	address: string,
	viewKey: string,
	signal?: AbortSignal,
): Promise<void> {
	await lwsPost<Record<string, unknown>>(lwsUrl, "/login", {
		address,
		view_key: viewKey,
		create_account: true,
		generated_locally: false,
	}, signal);
}

/**
 * Fetch incoming transactions for a Monero address.
 */
export async function fetchAddressTransactions(
	lwsUrl: string,
	address: string,
	viewKey: string,
	signal?: AbortSignal,
): Promise<LwsAddressTxsResponse> {
	return lwsPost<LwsAddressTxsResponse>(lwsUrl, "/get_address_txs", {
		address,
		view_key: viewKey,
	}, signal);
}
