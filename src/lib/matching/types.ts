import type { JournalEntry, LineItem } from "../types/index.js";
import type { TaskProgress } from "../task-queue.svelte.js";

/** A single "real movement" extracted from an entry with a suspense counterparty. */
export interface EntryMovement {
	entry: JournalEntry;
	items: LineItem[];
	realAccountName: string;
	realAccountId: string;
	currency: string;
	/** Signed decimal string (positive = debit, negative = credit). */
	amount: string;
	suspenseAccountName: string;
	suspenseAccountId: string;
	/** Expenses:*:Fees:* items. */
	feeItems: LineItem[];
	/** Non-suspense, non-fee, non-real items (preserved as-is in merge). */
	otherItems: LineItem[];
}

/** A scored candidate pair for merging. */
export interface MatchCandidate {
	movementA: EntryMovement;
	movementB: EntryMovement;
	confidence: "high" | "medium" | "low";
	score: number;
	matchedCurrency: string;
	amountDifferencePercent: number;
	dateDifferenceDays: number;
	hasReconciledItems: boolean;
}

export interface MergeResult {
	matched: number;
	skipped: number;
	warnings: string[];
	mergedEntryIds: string[];
}

export interface MergeOptions {
	dryRun?: boolean;
	signal?: AbortSignal;
	onProgress?: (p: TaskProgress) => void;
}
