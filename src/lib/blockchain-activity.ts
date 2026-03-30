/**
 * Activity-checking functions for all supported blockchain chains.
 * Each function makes the lightest possible API call to determine if an address
 * has ever had on-chain activity.
 *
 * Returns: true = active, false = empty, null = check failed or API key missing.
 */

import { cexFetch, abortableDelay } from "./cex/fetch.js";

type ActivityChecker = (address: string, signal?: AbortSignal, apiKey?: string) => Promise<boolean | null>;

const RATE_LIMIT_MS = 300;
let lastRequestTime = 0;

async function activityGet(
	url: string,
	baseUrl: string,
	proxyPrefix: string,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();
	return cexFetch(url, baseUrl, proxyPrefix, { method: "GET", headers: { Accept: "application/json", ...headers } }, signal);
}

async function activityPost(
	url: string,
	baseUrl: string,
	proxyPrefix: string,
	body: string,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();
	return cexFetch(url, baseUrl, proxyPrefix, {
		method: "POST",
		headers: { "Accept": "application/json", "Content-Type": "application/json", ...headers },
		body,
	}, signal);
}

// ---------------------------------------------------------------------------
// Keyless APIs
// ---------------------------------------------------------------------------

async function checkAlgorandActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://mainnet-idx.algonode.cloud/v2/accounts/${address}/transactions?limit=1`;
		const res = await activityGet(url, "https://mainnet-idx.algonode.cloud", "/api/algorand", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.transactions) && data.transactions.length > 0;
	} catch { return null; }
}

async function checkAptosActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.mainnet.aptoslabs.com/v1/accounts/${address}`;
		const res = await activityGet(url, "https://api.mainnet.aptoslabs.com", "/api/aptos", signal);
		if (res.status === 200) return true;
		if (res.status === 404) return false;
		return null;
	} catch { return null; }
}

async function checkCosmosActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://lcd-cosmoshub.keplr.app/cosmos/tx/v1beta1/txs?events=message.sender%3D'${address}'&pagination.limit=1`;
		const res = await activityGet(url, "https://lcd-cosmoshub.keplr.app", "/api/cosmos", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.tx_responses) && data.tx_responses.length > 0;
	} catch { return null; }
}

async function checkNearActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.nearblocks.io/v1/account/${address}/txns?per_page=1`;
		const res = await activityGet(url, "https://api.nearblocks.io", "/api/near", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.txns) && data.txns.length > 0;
	} catch { return null; }
}

async function checkStacksActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.hiro.so/extended/v1/address/${address}/transactions?limit=1`;
		const res = await activityGet(url, "https://api.hiro.so", "/api/stacks", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.results) && data.results.length > 0;
	} catch { return null; }
}

async function checkStellarActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://horizon.stellar.org/accounts/${address}/operations?limit=1&order=desc`;
		const res = await activityGet(url, "https://horizon.stellar.org", "/api/stellar", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data._embedded?.records) && data._embedded.records.length > 0;
	} catch { return null; }
}

async function checkTezosActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.tzkt.io/v1/accounts/${address}/operations?limit=1`;
		const res = await activityGet(url, "https://api.tzkt.io", "/api/tezos", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data) && data.length > 0;
	} catch { return null; }
}

async function checkTonActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://tonapi.io/v2/blockchain/accounts/${address}/transactions?limit=1`;
		const res = await activityGet(url, "https://tonapi.io", "/api/ton", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.transactions) && data.transactions.length > 0;
	} catch { return null; }
}

async function checkTronActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.trongrid.io/v1/accounts/${address}/transactions?limit=1`;
		const res = await activityGet(url, "https://api.trongrid.io", "/api/tron", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		if (!data.success) return null;
		return Array.isArray(data.data) && data.data.length > 0;
	} catch { return null; }
}

async function checkXrpActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = "https://xrplcluster.com/";
		const body = JSON.stringify({ method: "account_tx", params: [{ account: address, limit: 1 }] });
		const res = await activityPost(url, "https://xrplcluster.com", "/api/xrp", body, signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.result?.transactions) && data.result.transactions.length > 0;
	} catch { return null; }
}

async function checkKaspaActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.kaspa.org/addresses/${address}/balance`;
		const res = await activityGet(url, "https://api.kaspa.org", "/api/kaspa", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return typeof data.balance === "number" && data.balance > 0;
	} catch { return null; }
}

async function checkPolkadotActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://polkadot.api.subscan.io/api/v2/scan/transfers?address=${address}&row=1`;
		const res = await activityGet(url, "https://polkadot.api.subscan.io", "/api/polkadot", signal, { "Content-Type": "application/json" });
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.data?.list) && data.data.list.length > 0;
	} catch { return null; }
}

async function checkBittensorActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://bittensor.api.subscan.io/api/v2/scan/transfers?address=${address}&row=1`;
		const res = await activityGet(url, "https://bittensor.api.subscan.io", "/api/bittensor", signal, { "Content-Type": "application/json" });
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.data?.list) && data.data.list.length > 0;
	} catch { return null; }
}

async function checkSuiActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const query = `{ transactionBlocks(filter: { changedObject: "${address}" }, first: 1) { nodes { digest } } }`;
		const res = await activityPost("https://graphql.mainnet.sui.io", "https://graphql.mainnet.sui.io", "/api/sui", JSON.stringify({ query }), signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.data?.transactionBlocks?.nodes) && data.data.transactionBlocks.nodes.length > 0;
	} catch { return null; }
}

// BTC forks via Blockchair
async function checkBlockchairActivity(chain: string, address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://api.blockchair.com/${chain}/dashboards/address/${address}`;
		const res = await activityGet(url, "https://api.blockchair.com", "/api/blockchair", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		const addrData = data.data?.[address]?.address;
		if (!addrData) return null;
		return (addrData.transaction_count ?? 0) > 0;
	} catch { return null; }
}

async function checkDogeActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	return checkBlockchairActivity("dogecoin", address, signal);
}

async function checkLtcActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	return checkBlockchairActivity("litecoin", address, signal);
}

async function checkDashActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	return checkBlockchairActivity("dash", address, signal);
}

async function checkZcashActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	return checkBlockchairActivity("zcash", address, signal);
}

// ---------------------------------------------------------------------------
// API-key-required chains
// ---------------------------------------------------------------------------

async function checkSolanaActivity(address: string, signal?: AbortSignal, apiKey?: string): Promise<boolean | null> {
	if (!apiKey) return null;
	try {
		const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=1`;
		const res = await activityGet(url, "https://api.helius.xyz", "/api/helius", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data) && data.length > 0;
	} catch { return null; }
}

async function checkCardanoActivity(address: string, signal?: AbortSignal, apiKey?: string): Promise<boolean | null> {
	if (!apiKey) return null;
	try {
		const url = `https://cardano-mainnet.blockfrost.io/api/v1/addresses/${address}/transactions?count=1`;
		const res = await activityGet(url, "https://cardano-mainnet.blockfrost.io", "/api/blockfrost", signal, { project_id: apiKey });
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data) && data.length > 0;
	} catch { return null; }
}

// ---------------------------------------------------------------------------
// Bitcoin (uses existing mempool.space API)
// ---------------------------------------------------------------------------

export async function checkBtcActivity(address: string, signal?: AbortSignal): Promise<boolean | null> {
	try {
		const url = `https://mempool.space/api/address/${address}`;
		const res = await activityGet(url, "https://mempool.space", "/api/mempool", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		const txCount = (data.chain_stats?.tx_count ?? 0) + (data.mempool_stats?.tx_count ?? 0);
		return txCount > 0;
	} catch { return null; }
}

// ---------------------------------------------------------------------------
// EVM (Etherscan V2)
// ---------------------------------------------------------------------------

export async function checkEvmActivity(address: string, etherscanApiKey: string, signal?: AbortSignal): Promise<boolean | null> {
	if (!etherscanApiKey) return null;
	try {
		const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${etherscanApiKey}`;
		const res = await activityGet(url, "https://api.etherscan.io", "/api/etherscan", signal);
		if (res.status !== 200) return null;
		const data = JSON.parse(res.body);
		return Array.isArray(data.result) && data.result.length > 0;
	} catch { return null; }
}

// ---------------------------------------------------------------------------
// Factory / registry
// ---------------------------------------------------------------------------

const CHECKERS: Record<string, ActivityChecker> = {
	algorand: checkAlgorandActivity,
	aptos: checkAptosActivity,
	bittensor: checkBittensorActivity,
	cardano: checkCardanoActivity,
	cosmos: checkCosmosActivity,
	dash: checkDashActivity,
	doge: checkDogeActivity,
	kaspa: checkKaspaActivity,
	ltc: checkLtcActivity,
	near: checkNearActivity,
	polkadot: checkPolkadotActivity,
	sol: checkSolanaActivity,
	stacks: checkStacksActivity,
	stellar: checkStellarActivity,
	sui: checkSuiActivity,
	tezos: checkTezosActivity,
	ton: checkTonActivity,
	tron: checkTronActivity,
	xrp: checkXrpActivity,
	zcash: checkZcashActivity,
};

/**
 * Returns an activity checker function for the given chain ID, or null if
 * activity checking is not supported for that chain.
 */
export function getActivityChecker(chainId: string): ActivityChecker | null {
	return CHECKERS[chainId] ?? null;
}
