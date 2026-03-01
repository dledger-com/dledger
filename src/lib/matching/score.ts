import Decimal from "decimal.js-light";
import type { EntryMovement, MatchCandidate } from "./types.js";

/**
 * Extract the source prefix from an entry's source field.
 * e.g. "etherscan:1:0xabc" → "etherscan", "cex:kraken:deposit" → "cex:kraken",
 *      "csv-import:revolut" → "csv-import:revolut", "pdf-n26" → "pdf-n26"
 */
function sourcePrefix(source: string): string {
	// For etherscan, cex, csv-import, ofx, pdf sources — use first 2 colon-separated segments
	const parts = source.split(":");
	if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
	return parts[0];
}

function daysBetween(dateA: string, dateB: string): number {
	const a = new Date(dateA + "T00:00:00Z").getTime();
	const b = new Date(dateB + "T00:00:00Z").getTime();
	return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function amountDiffPercent(a: string, b: string): number {
	const absA = new Decimal(a).abs();
	const absB = new Decimal(b).abs();
	if (absA.isZero() && absB.isZero()) return 0;
	const max = absA.gt(absB) ? absA : absB;
	if (max.isZero()) return 0;
	return absA.minus(absB).abs().div(max).times(100).toNumber();
}

function scoreAmount(diffPercent: number): number {
	if (diffPercent === 0) return 50;
	if (diffPercent <= 1) return 45;
	if (diffPercent <= 5) return 30;
	if (diffPercent <= 10) return 15;
	return 0;
}

function scoreDate(daysDiff: number): number {
	if (daysDiff === 0) return 30;
	if (daysDiff <= 1) return 25;
	if (daysDiff <= 2) return 20;
	if (daysDiff <= 3) return 15;
	if (daysDiff <= 5) return 10;
	if (daysDiff <= 7) return 5;
	return 0;
}

function scoreTxidMatch(
	metaA: Record<string, string> | undefined,
	metaB: Record<string, string> | undefined,
): number {
	if (!metaA || !metaB) return 0;
	const txidA = metaA["txid"];
	const txidB = metaB["txid"];
	if (txidA && txidB && txidA.toLowerCase() === txidB.toLowerCase()) return 20;
	return 0;
}

function confidenceLevel(score: number): "high" | "medium" | "low" {
	if (score >= 70) return "high";
	if (score >= 50) return "medium";
	return "low";
}

/**
 * Find matching pairs among candidate movements.
 * Buckets by currency, then compares debit vs credit within each bucket.
 */
export function findMatches(
	candidates: EntryMovement[],
	metadataMap: Map<string, Record<string, string>>,
): MatchCandidate[] {
	// Bucket by currency
	const byDebit = new Map<string, EntryMovement[]>();
	const byCredit = new Map<string, EntryMovement[]>();

	for (const m of candidates) {
		const amt = new Decimal(m.amount);
		const bucket = amt.gte(0) ? byDebit : byCredit;
		const list = bucket.get(m.currency) ?? [];
		list.push(m);
		bucket.set(m.currency, list);
	}

	const matches: MatchCandidate[] = [];
	const usedA = new Set<string>();
	const usedB = new Set<string>();

	// For each currency, compare debits with credits
	for (const currency of new Set([...byDebit.keys(), ...byCredit.keys()])) {
		const debits = byDebit.get(currency) ?? [];
		const credits = byCredit.get(currency) ?? [];

		// Score all pairs, then greedily assign best matches
		const scored: Array<{ a: EntryMovement; b: EntryMovement; score: number; diffPct: number; daysDiff: number }> = [];

		for (const a of debits) {
			for (const b of credits) {
				// Required: different source prefixes
				if (sourcePrefix(a.entry.source) === sourcePrefix(b.entry.source)) continue;

				// Required: date within 7 days
				const daysDiff = daysBetween(a.entry.date, b.entry.date);
				if (daysDiff > 7) continue;

				// Required: amount within 10%
				const diffPct = amountDiffPercent(a.amount, b.amount);
				if (diffPct > 10) continue;

				const metaA = metadataMap.get(a.entry.id);
				const metaB = metadataMap.get(b.entry.id);

				const score =
					scoreAmount(diffPct) +
					scoreDate(daysDiff) +
					scoreTxidMatch(metaA, metaB);

				scored.push({ a, b, score, diffPct, daysDiff });
			}
		}

		// Sort by score descending, then greedily pick non-overlapping pairs
		scored.sort((x, y) => y.score - x.score);

		for (const pair of scored) {
			if (usedA.has(pair.a.entry.id) || usedB.has(pair.b.entry.id)) continue;

			usedA.add(pair.a.entry.id);
			usedB.add(pair.b.entry.id);

			matches.push({
				movementA: pair.a,
				movementB: pair.b,
				confidence: confidenceLevel(pair.score),
				score: pair.score,
				matchedCurrency: currency,
				amountDifferencePercent: Math.round(pair.diffPct * 100) / 100,
				dateDifferenceDays: pair.daysDiff,
				hasReconciledItems: false, // Could check reconciliation status if needed
			});
		}
	}

	// Sort matches: high confidence first, then by score
	matches.sort((a, b) => {
		const conf = { high: 0, medium: 1, low: 2 };
		if (conf[a.confidence] !== conf[b.confidence]) return conf[a.confidence] - conf[b.confidence];
		return b.score - a.score;
	});

	return matches;
}
