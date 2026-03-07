/**
 * Derives a human-readable position label for the journal virtual scroll indicator.
 */
import type { JournalEntry, LineItem } from "$lib/types/index.js";
import type { SortDirection } from "./sort.js";

export type JournalSortKey = "date" | "description" | "status" | "amount" | "account";

/**
 * Returns a compact label describing what's currently visible in the virtual scroll viewport.
 *
 * | Sort key    | Label example                                |
 * |-------------|----------------------------------------------|
 * | "date"      | "March 2024" / "Mar–Jun 2024" / "Dec 2023 – Mar 2024" |
 * | "description" | "D" / "D–F"                                |
 * | "status"    | "confirmed" / "confirmed – pending"          |
 * | "amount"    | formatted range using formatDebitTotal        |
 * | null        | "50–75" (row range)                          |
 */
export function derivePositionLabel(
	sortedEntries: JournalEntry[],
	firstIndex: number,
	lastIndex: number,
	sortKey: JournalSortKey | null,
	_sortDirection: SortDirection | null,
	formatDebitTotal: (items: { amount: string; currency: string }[]) => string,
	getItems?: (entryId: string) => LineItem[],
): string {
	if (sortedEntries.length === 0) return "";
	const first = sortedEntries[firstIndex];
	const last = sortedEntries[lastIndex];
	if (!first || !last) return "";

	if (!sortKey) {
		// No sort — show row range
		if (firstIndex === lastIndex) return String(firstIndex + 1);
		return `${firstIndex + 1}–${lastIndex + 1}`;
	}

	switch (sortKey) {
		case "date":
			return deriveDateLabel(first.date, last.date);
		case "description":
			return deriveLetterLabel(first.description, last.description);
		case "status":
			return deriveStatusLabel(first.status, last.status);
		case "amount": {
			const firstItems = getItems ? getItems(first.id) : [];
			const lastItems = getItems ? getItems(last.id) : [];
			return deriveAmountLabel(firstItems, lastItems, formatDebitTotal);
		}
		case "account":
			// Account names are resolved outside this module; fall back to row range
			if (firstIndex === lastIndex) return String(firstIndex + 1);
			return `${firstIndex + 1}–${lastIndex + 1}`;
	}
}

function deriveDateLabel(firstDate: string, lastDate: string): string {
	const a = parseYearMonth(firstDate);
	const b = parseYearMonth(lastDate);
	if (!a || !b) return "";

	if (a.year === b.year && a.month === b.month) {
		// Same month — "March 2024"
		return formatMonth(a.month, "long") + " " + a.year;
	}
	if (a.year === b.year) {
		// Same year, different months — "Mar–Jun 2024"
		return formatMonth(a.month, "short") + "–" + formatMonth(b.month, "short") + " " + a.year;
	}
	// Different years — "Dec 2023 – Mar 2024"
	return (
		formatMonth(a.month, "short") + " " + a.year + " – " +
		formatMonth(b.month, "short") + " " + b.year
	);
}

function parseYearMonth(dateStr: string): { year: number; month: number } | null {
	// Expects "YYYY-MM-DD" format
	const parts = dateStr.split("-");
	if (parts.length < 2) return null;
	const year = parseInt(parts[0], 10);
	const month = parseInt(parts[1], 10);
	if (isNaN(year) || isNaN(month)) return null;
	return { year, month };
}

function formatMonth(month: number, style: "long" | "short"): string {
	// month is 1-based; use "en" for deterministic output across locales
	const d = new Date(2024, month - 1, 1);
	return d.toLocaleString("en", { month: style });
}

function deriveLetterLabel(firstDesc: string, lastDesc: string): string {
	const a = firstDesc.charAt(0).toUpperCase();
	const b = lastDesc.charAt(0).toUpperCase();
	if (!a) return "";
	if (a === b) return a;
	return `${a}–${b}`;
}

function deriveStatusLabel(firstStatus: string, lastStatus: string): string {
	if (firstStatus === lastStatus) return firstStatus;
	return `${firstStatus} – ${lastStatus}`;
}

function deriveAmountLabel(
	firstItems: LineItem[],
	lastItems: LineItem[],
	formatDebitTotal: (items: { amount: string; currency: string }[]) => string,
): string {
	const a = formatDebitTotal(firstItems);
	const b = formatDebitTotal(lastItems);
	if (a === b) return a;
	return `${a} – ${b}`;
}
