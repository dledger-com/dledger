// Hyperliquid ↔ Etherscan (Arbitrum) consolidation.
// Matches deposits/withdrawals with Arbitrum bridge transactions.

import type { Backend } from "../backend.js";
import { findEtherscanSourceByTxid } from "../cex/pipeline.js";

const ARBITRUM_CHAIN_ID = 42161;
const TIME_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface HlConsolidationResult {
	matched: boolean;
	etherscanSource?: string;
	method?: "txid" | "heuristic";
	warning?: string;
}

/**
 * Attempt to consolidate a Hyperliquid deposit/withdrawal with an existing
 * Etherscan entry on Arbitrum.
 *
 * Strategy:
 * 1. Try exact txid match via `findEtherscanSourceByTxid`
 * 2. Fall back to amount + timestamp proximity (within 1 hour)
 */
export async function consolidateHlWithEtherscan(
	backend: Backend,
	hlHash: string,
	usdcAmount: string,
	timestampMs: number,
	existingSources: Set<string>,
): Promise<HlConsolidationResult> {
	// 1. Try exact hash match
	const byTxid = findEtherscanSourceByTxid(existingSources, hlHash);
	if (byTxid) {
		return { matched: true, etherscanSource: byTxid, method: "txid" };
	}

	// 2. Heuristic: find Arbitrum Etherscan entries with matching USDC amount within time window
	const hlDate = new Date(timestampMs);
	const candidates: Array<{ source: string; entryDate: string }> = [];

	// Query metadata for entries with matching USDC amounts on Arbitrum
	const arbSources: string[] = [];
	for (const src of existingSources) {
		if (src.startsWith(`etherscan:${ARBITRUM_CHAIN_ID}:`)) {
			arbSources.push(src);
		}
	}

	if (arbSources.length === 0) {
		return { matched: false };
	}

	// Check entries by querying journal for matching amounts within the time window
	const allEntries = await backend.queryJournalEntries({});
	for (const [entry, lineItems] of allEntries) {
		if (!arbSources.includes(entry.source)) continue;
		if (entry.voided_by) continue;

		// Check if any line item has matching USDC amount (absolute value)
		const absTarget = Math.abs(parseFloat(usdcAmount));
		const hasMatchingAmount = lineItems.some((li) => {
			if (li.currency !== "USDC") return false;
			const absAmount = Math.abs(parseFloat(li.amount));
			// Allow 0.1% tolerance for rounding
			return Math.abs(absAmount - absTarget) / absTarget < 0.001;
		});

		if (!hasMatchingAmount) continue;

		// Check timestamp proximity
		const entryDate = new Date(entry.date);
		const timeDiff = Math.abs(entryDate.getTime() - hlDate.getTime());
		if (timeDiff <= TIME_WINDOW_MS) {
			candidates.push({ source: entry.source, entryDate: entry.date });
		}
	}

	if (candidates.length === 0) {
		return { matched: false };
	}

	if (candidates.length > 1) {
		return {
			matched: false,
			warning: `Ambiguous Arbitrum match: ${candidates.length} candidates for ${usdcAmount} USDC near ${hlDate.toISOString()}. Manual linking recommended.`,
		};
	}

	return { matched: true, etherscanSource: candidates[0].source, method: "heuristic" };
}
