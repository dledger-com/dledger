import type { JournalEntry, LineItem } from "../types/index.js";
import type { EntryMovement } from "./types.js";
import { isSuspenseAccount, isFeeAccount } from "./suspense.js";

/**
 * Extract the "real movement" from a journal entry that has a suspense counterparty.
 *
 * Returns null if:
 * - No suspense line items found
 * - Multiple suspense items in different currencies
 * - Entry is voided
 */
export function extractMovement(
	entry: JournalEntry,
	items: LineItem[],
	accountIdToName: Map<string, string>,
): EntryMovement | null {
	if (entry.voided_by) return null;

	const suspenseItems: LineItem[] = [];
	const feeItems: LineItem[] = [];
	const realItems: LineItem[] = [];
	const otherItems: LineItem[] = [];

	for (const item of items) {
		const name = accountIdToName.get(item.account_id);
		if (!name) {
			otherItems.push(item);
			continue;
		}

		if (isSuspenseAccount(name)) {
			suspenseItems.push(item);
		} else if (isFeeAccount(name)) {
			feeItems.push(item);
		} else {
			realItems.push(item);
		}
	}

	if (suspenseItems.length === 0) return null;

	// Reject if suspense items span multiple currencies
	const suspenseCurrencies = new Set(suspenseItems.map((i) => i.currency));
	if (suspenseCurrencies.size > 1) return null;

	// Pick the primary real item — the one in the same currency as suspense, or the largest
	const suspenseCurrency = suspenseItems[0].currency;
	let primaryReal: LineItem | null = null;

	// Prefer real items matching the suspense currency
	const sameCurrencyReals = realItems.filter((i) => i.currency === suspenseCurrency);
	if (sameCurrencyReals.length > 0) {
		primaryReal = sameCurrencyReals.reduce((best, item) =>
			Math.abs(parseFloat(item.amount)) > Math.abs(parseFloat(best.amount)) ? item : best,
		);
	} else if (realItems.length > 0) {
		// Fall back to the largest real item by absolute amount
		primaryReal = realItems.reduce((best, item) =>
			Math.abs(parseFloat(item.amount)) > Math.abs(parseFloat(best.amount)) ? item : best,
		);
	}

	if (!primaryReal) return null;

	const primaryRealName = accountIdToName.get(primaryReal.account_id);
	if (!primaryRealName) return null;

	// Everything else that's real but not the primary goes to otherItems
	const finalOtherItems = [
		...otherItems,
		...realItems.filter((i) => i.id !== primaryReal!.id),
	];

	return {
		entry,
		items,
		realAccountName: primaryRealName,
		realAccountId: primaryReal.account_id,
		currency: primaryReal.currency,
		amount: primaryReal.amount,
		suspenseAccountName: accountIdToName.get(suspenseItems[0].account_id) ?? suspenseItems[0].account_id,
		suspenseAccountId: suspenseItems[0].account_id,
		feeItems,
		otherItems: finalOtherItems,
	};
}

/**
 * Extract all candidate movements from a set of entries.
 * Skips entries that are already linked (by id in alreadyLinkedIds).
 */
export function extractAllCandidates(
	entries: [JournalEntry, LineItem[]][],
	accountIdToName: Map<string, string>,
	alreadyLinkedIds: Set<string>,
): EntryMovement[] {
	const result: EntryMovement[] = [];
	for (const [entry, items] of entries) {
		if (alreadyLinkedIds.has(entry.id)) continue;
		const movement = extractMovement(entry, items, accountIdToName);
		if (movement) result.push(movement);
	}
	return result;
}
