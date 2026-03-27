// Multi-API client for BTC-fork chains (mempool / blockcypher / blockchair).

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { BtcForkChainConfig, NormalizedTx } from "./types.js";

const RATE_LIMIT_MS = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

let lastRequestTime = 0;

/** @internal Reset rate limiter state (for testing only). */
export function _resetRateLimiter(): void {
	lastRequestTime = 0;
}

async function rateLimitedGet(
	url: string,
	baseUrl: string,
	proxyPrefix: string,
	signal?: AbortSignal,
): Promise<string> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, baseUrl, proxyPrefix, { method: "GET" }, signal);
		if (res.status === 200) return res.body;
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Max retries exceeded");
}

// ── Mempool-style (LTC via litecoinspace.org) ────────────

interface MempoolTx {
	txid: string;
	status: { confirmed: boolean; block_time?: number };
	vin: { prevout: { scriptpubkey_address?: string; value?: number } | null }[];
	vout: { scriptpubkey_address?: string; value?: number }[];
	fee: number;
}

function normalizeMempoolTx(tx: MempoolTx): NormalizedTx | null {
	if (!tx.status.confirmed || !tx.status.block_time) return null;
	return {
		txid: tx.txid,
		timestamp: tx.status.block_time,
		inputs: tx.vin
			.filter((v) => v.prevout?.scriptpubkey_address && v.prevout.value != null)
			.map((v) => ({ address: v.prevout!.scriptpubkey_address!, value: v.prevout!.value! })),
		outputs: tx.vout
			.filter((v) => v.scriptpubkey_address && v.value != null)
			.map((v) => ({ address: v.scriptpubkey_address!, value: v.value! })),
		fee: tx.fee,
	};
}

async function fetchMempool(
	config: BtcForkChainConfig,
	address: string,
	signal?: AbortSignal,
): Promise<NormalizedTx[]> {
	const allTxs: NormalizedTx[] = [];
	let lastTxid: string | undefined;

	while (true) {
		const url = lastTxid
			? `${config.apiBaseUrl}/api/address/${address}/txs/chain/${lastTxid}`
			: `${config.apiBaseUrl}/api/address/${address}/txs`;

		const body = await rateLimitedGet(url, config.apiBaseUrl, config.apiProxyPrefix, signal);
		const txs: MempoolTx[] = JSON.parse(body);

		if (txs.length === 0) break;
		for (const tx of txs) {
			const n = normalizeMempoolTx(tx);
			if (n) allTxs.push(n);
		}

		if (txs.length < 25) break;
		lastTxid = txs[txs.length - 1].txid;
	}

	return allTxs;
}

// ── BlockCypher-style (DOGE) ─────────────────────────────

interface BlockCypherTx {
	hash: string;
	confirmed?: string; // ISO datetime
	inputs: { addresses?: string[]; output_value?: number }[];
	outputs: { addresses?: string[]; value?: number }[];
	fees: number;
}

interface BlockCypherResponse {
	txs?: BlockCypherTx[];
	hasMore?: boolean;
}

function normalizeBlockCypherTx(tx: BlockCypherTx): NormalizedTx | null {
	if (!tx.confirmed) return null;
	const timestamp = Math.floor(new Date(tx.confirmed).getTime() / 1000);
	return {
		txid: tx.hash,
		timestamp,
		inputs: tx.inputs
			.filter((inp) => inp.addresses && inp.addresses.length > 0 && inp.output_value != null)
			.map((inp) => ({ address: inp.addresses![0], value: inp.output_value! })),
		outputs: tx.outputs
			.filter((out) => out.addresses && out.addresses.length > 0 && out.value != null)
			.map((out) => ({ address: out.addresses![0], value: out.value! })),
		fee: tx.fees,
	};
}

async function fetchBlockCypher(
	config: BtcForkChainConfig,
	address: string,
	signal?: AbortSignal,
): Promise<NormalizedTx[]> {
	const allTxs: NormalizedTx[] = [];
	let before = 0;

	while (true) {
		const coin = config.id; // "doge"
		const url = before > 0
			? `${config.apiBaseUrl}/v1/${coin}/main/addrs/${address}/full?limit=50&before=${before}`
			: `${config.apiBaseUrl}/v1/${coin}/main/addrs/${address}/full?limit=50`;

		const body = await rateLimitedGet(url, config.apiBaseUrl, config.apiProxyPrefix, signal);
		const data: BlockCypherResponse = JSON.parse(body);
		const txs = data.txs ?? [];

		if (txs.length === 0) break;
		for (const tx of txs) {
			const n = normalizeBlockCypherTx(tx);
			if (n) allTxs.push(n);
		}

		if (!data.hasMore || txs.length < 50) break;
		// BlockCypher uses block height for pagination
		const lastTx = txs[txs.length - 1];
		if (lastTx.confirmed) {
			before = allTxs.length; // offset-based
		} else {
			break;
		}
	}

	return allTxs;
}

// ── Blockchair-style (BCH) ───────────────────────────────

interface BlockchairTxDetail {
	hash: string;
	time: string;                  // ISO datetime
	fee: number;
	input_total: number;
	output_total: number;
}

interface BlockchairInput {
	recipient: string;
	value: number;
}

interface BlockchairOutput {
	recipient: string;
	value: number;
}

interface BlockchairDashboard {
	data: Record<string, {
		address: { transaction_count: number };
		transactions: BlockchairTxDetail[];
	}>;
}

interface BlockchairRawTx {
	data: Record<string, {
		transaction: BlockchairTxDetail;
		inputs: BlockchairInput[];
		outputs: BlockchairOutput[];
	}>;
}

function normalizeBlockchairTx(
	detail: BlockchairTxDetail,
	inputs: BlockchairInput[],
	outputs: BlockchairOutput[],
): NormalizedTx {
	return {
		txid: detail.hash,
		timestamp: Math.floor(new Date(detail.time).getTime() / 1000),
		inputs: inputs.map((inp) => ({ address: inp.recipient, value: inp.value })),
		outputs: outputs.map((out) => ({ address: out.recipient, value: out.value })),
		fee: detail.fee,
	};
}

async function fetchBlockchair(
	config: BtcForkChainConfig,
	address: string,
	signal?: AbortSignal,
): Promise<NormalizedTx[]> {
	// First, get the list of transaction hashes from the dashboard
	const chainPath = config.blockchairPath ?? config.id;
	const dashUrl = `${config.apiBaseUrl}/${chainPath}/dashboards/address/${address}?transaction_details=true&limit=100`;
	const dashBody = await rateLimitedGet(dashUrl, config.apiBaseUrl, config.apiProxyPrefix, signal);
	const dash: BlockchairDashboard = JSON.parse(dashBody);

	const addrData = Object.values(dash.data)[0];
	if (!addrData || addrData.transactions.length === 0) return [];

	// Fetch full tx details in batches of 10 (Blockchair limit)
	const allTxs: NormalizedTx[] = [];
	const txDetails = addrData.transactions;

	for (let i = 0; i < txDetails.length; i += 10) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const batch = txDetails.slice(i, i + 10);
		const hashes = batch.map((t) => t.hash).join(",");
		const txUrl = `${config.apiBaseUrl}/${chainPath}/dashboards/transactions/${hashes}`;
		const txBody = await rateLimitedGet(txUrl, config.apiBaseUrl, config.apiProxyPrefix, signal);
		const txData: BlockchairRawTx = JSON.parse(txBody);

		for (const hash of batch.map((t) => t.hash)) {
			const entry = txData.data[hash];
			if (!entry) continue;
			allTxs.push(normalizeBlockchairTx(entry.transaction, entry.inputs, entry.outputs));
		}
	}

	return allTxs;
}

// ── Public API ───────────────────────────────────────────

/**
 * Fetch and normalize all transactions for an address on any BTC-fork chain.
 * Dispatches to the appropriate API style based on config.
 */
export async function fetchTransactions(
	config: BtcForkChainConfig,
	address: string,
	signal?: AbortSignal,
): Promise<NormalizedTx[]> {
	switch (config.apiStyle) {
		case "mempool":
			return fetchMempool(config, address, signal);
		case "blockcypher":
			return fetchBlockCypher(config, address, signal);
		case "blockchair":
			return fetchBlockchair(config, address, signal);
	}
}
