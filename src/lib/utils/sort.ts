/**
 * Reusable sort utilities for table column sorting.
 */

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
	readonly key: K | null;
	readonly direction: SortDirection | null;
	toggle(key: K): void;
	reset(): void;
}

export type SortAccessor<T> = (item: T) => string | number | null | undefined;

/**
 * Parse a formatted currency string into a number for sorting.
 * Handles "$1,234.56", "-500.00", "1 203,55", "+$500.00 EUR", etc.
 */
export function parseCurrencyForSort(str: string): number {
	// Remove currency symbols, letters, and whitespace-like chars except digits, dots, commas, minus, plus
	let cleaned = str.replace(/[^0-9.,-]/g, "");

	if (!cleaned || cleaned === "-" || cleaned === "+" || cleaned === "." || cleaned === ",") {
		return 0;
	}

	// Determine if comma is decimal separator:
	// If last separator is comma and has 1-2 digits after it (European format)
	const lastComma = cleaned.lastIndexOf(",");
	const lastDot = cleaned.lastIndexOf(".");

	if (lastComma > lastDot) {
		// Comma is the last separator — European format: "1.203,55" or "1 203,55"
		cleaned = cleaned.replace(/\./g, "").replace(",", ".");
	} else {
		// Dot is the last separator or no comma — standard: "1,234.56"
		cleaned = cleaned.replace(/,/g, "");
	}

	const n = parseFloat(cleaned);
	return isNaN(n) ? 0 : n;
}

/**
 * Sort items by accessor and direction. Returns a new array.
 * Nulls/undefined always sort last regardless of direction.
 */
export function sortItems<T>(
	items: T[],
	accessor: SortAccessor<T>,
	direction: SortDirection
): T[] {
	const multiplier = direction === "asc" ? 1 : -1;

	return [...items].sort((a, b) => {
		const va = accessor(a);
		const vb = accessor(b);

		// Nulls always last
		const aNull = va == null || va === "";
		const bNull = vb == null || vb === "";
		if (aNull && bNull) return 0;
		if (aNull) return 1;
		if (bNull) return -1;

		if (typeof va === "number" && typeof vb === "number") {
			return (va - vb) * multiplier;
		}

		// String comparison with locale-aware numeric sorting
		return String(va).localeCompare(String(vb), undefined, { numeric: true }) * multiplier;
	});
}
