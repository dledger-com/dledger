// Sui GraphQL API client.
// Endpoint: POST https://graphql.mainnet.sui.io/graphql — no auth required.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type { SuiTransactionNode, SuiPageInfo } from "./types.js";

const SUI_GRAPHQL_URL = "https://graphql.mainnet.sui.io";
const SUI_PROXY_PREFIX = "/api/sui";
const RATE_LIMIT_MS = 100;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;
const PAGE_SIZE = 50;

let lastRequestTime = 0;

export function _resetRateLimiter(): void { lastRequestTime = 0; }

async function suiGraphQL<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
	lastRequestTime = Date.now();

	const url = `${SUI_GRAPHQL_URL}/graphql`;
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	};

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const res = await cexFetch(url, SUI_GRAPHQL_URL, SUI_PROXY_PREFIX, init, signal);
		if (res.status === 200) {
			const json = JSON.parse(res.body);
			if (json.errors) throw new Error(`Sui GraphQL error: ${JSON.stringify(json.errors[0]?.message ?? json.errors)}`);
			return json.data as T;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
			lastRequestTime = Date.now();
			continue;
		}
		throw new Error(`Sui API error ${res.status}: ${res.body.slice(0, 500)}`);
	}
	throw new Error("Sui API: max retries exceeded");
}

const TX_QUERY = `
query ($address: SuiAddress!, $first: Int!, $after: String) {
  transactionBlocks(filter: {affectedAddress: $address}, first: $first, after: $after) {
    nodes {
      digest
      effects {
        timestamp
        status
        balanceChanges {
          nodes {
            owner { asAddress { address } }
            coinType { repr }
            amount
          }
        }
        gasEffects {
          gasSummary { computationCost storageCost storageRebate }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * Fetch all transactions for a Sui address, paginated via cursor.
 */
export async function fetchTransactions(
	address: string,
	afterCursor?: string,
	signal?: AbortSignal,
): Promise<{ nodes: SuiTransactionNode[]; endCursor: string | null }> {
	const allNodes: SuiTransactionNode[] = [];
	let cursor = afterCursor ?? null;

	while (true) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const data = await suiGraphQL<{
			transactionBlocks: { nodes: SuiTransactionNode[]; pageInfo: SuiPageInfo };
		}>(TX_QUERY, { address, first: PAGE_SIZE, after: cursor }, signal);

		const page = data.transactionBlocks;
		allNodes.push(...page.nodes);

		if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
			return { nodes: allNodes, endCursor: page.pageInfo.endCursor };
		}
		cursor = page.pageInfo.endCursor;
	}
}
