import { describe, it, expect } from "vitest";
import { derivePositionLabel, type JournalSortKey } from "$lib/utils/scroll-position.js";
import type { JournalEntry, LineItem } from "$lib/types/index.js";

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
	return {
		id: "1",
		date: "2024-03-15",
		description: "Test",
		status: "confirmed",
		source: "manual",
		voided_by: null,
		created_at: "2024-03-15T00:00:00Z",
		...overrides,
	};
}

function makeItems(amounts: [string, string][] = [["100", "USD"]]): LineItem[] {
	return amounts.map(([amount, currency], i) => ({
		id: String(i),
		journal_entry_id: "1",
		account_id: "acc",
		currency,
		amount,
		lot_id: null,
	}));
}

function makeEntries(overrides: Partial<JournalEntry>[]): JournalEntry[] {
	return overrides.map((e, i) => makeEntry({ id: String(i + 1), ...e }));
}

const defaultFormat = (items: { amount: string; currency: string }[]) =>
	items
		.filter((i) => parseFloat(i.amount) > 0)
		.map((i) => `${i.amount} ${i.currency}`)
		.join(", ") || "0";

describe("derivePositionLabel", () => {
	describe("empty / edge cases", () => {
		it("returns empty string for empty entries", () => {
			expect(derivePositionLabel([], 0, 0, "date", "asc", defaultFormat)).toBe("");
		});

		it("returns empty string for out-of-range indices", () => {
			const entries = makeEntries([{ date: "2024-03-15" }]);
			expect(derivePositionLabel(entries, 5, 10, "date", "asc", defaultFormat)).toBe("");
		});

		it("handles single entry", () => {
			const entries = makeEntries([{ date: "2024-03-15" }]);
			const label = derivePositionLabel(entries, 0, 0, "date", "asc", defaultFormat);
			expect(label).toContain("2024");
		});
	});

	describe("sortKey = null (row range)", () => {
		it("shows single row number when first === last", () => {
			const entries = makeEntries([{ date: "2024-01-01" }, { date: "2024-02-01" }]);
			expect(derivePositionLabel(entries, 0, 0, null, null, defaultFormat)).toBe("1");
		});

		it("shows row range", () => {
			const entries = makeEntries([
				{ date: "2024-01-01" },
				{ date: "2024-02-01" },
				{ date: "2024-03-01" },
			]);
			expect(derivePositionLabel(entries, 0, 2, null, null, defaultFormat)).toBe("1–3");
		});

		it("shows correct 1-based range in the middle", () => {
			const entries = makeEntries(Array.from({ length: 100 }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, "0")}` })));
			expect(derivePositionLabel(entries, 49, 74, null, null, defaultFormat)).toBe("50–75");
		});
	});

	describe("sortKey = 'date'", () => {
		it("shows full month+year for same month", () => {
			const entries = makeEntries([
				{ date: "2024-03-01" },
				{ date: "2024-03-15" },
				{ date: "2024-03-31" },
			]);
			const label = derivePositionLabel(entries, 0, 2, "date", "asc", defaultFormat);
			expect(label).toMatch(/march\s+2024/i);
		});

		it("shows short month range for same year", () => {
			const entries = makeEntries([
				{ date: "2024-03-01" },
				{ date: "2024-04-15" },
				{ date: "2024-06-30" },
			]);
			const label = derivePositionLabel(entries, 0, 2, "date", "asc", defaultFormat);
			expect(label).toMatch(/mar/i);
			expect(label).toMatch(/jun/i);
			expect(label).toContain("2024");
			expect(label).toContain("–");
		});

		it("shows cross-year range", () => {
			const entries = makeEntries([
				{ date: "2023-12-01" },
				{ date: "2024-01-15" },
				{ date: "2024-03-30" },
			]);
			const label = derivePositionLabel(entries, 0, 2, "date", "asc", defaultFormat);
			expect(label).toMatch(/dec/i);
			expect(label).toContain("2023");
			expect(label).toMatch(/mar/i);
			expect(label).toContain("2024");
		});

		it("handles single entry date", () => {
			const entries = makeEntries([{ date: "2024-06-15" }]);
			const label = derivePositionLabel(entries, 0, 0, "date", "asc", defaultFormat);
			expect(label).toMatch(/june?\s+2024/i);
		});
	});

	describe("sortKey = 'description'", () => {
		it("shows single letter when same first letter", () => {
			const entries = makeEntries([
				{ description: "Dinner" },
				{ description: "Drinks" },
			]);
			expect(derivePositionLabel(entries, 0, 1, "description", "asc", defaultFormat)).toBe("D");
		});

		it("shows letter range", () => {
			const entries = makeEntries([
				{ description: "Dinner" },
				{ description: "Electricity" },
				{ description: "Fuel" },
			]);
			expect(derivePositionLabel(entries, 0, 2, "description", "asc", defaultFormat)).toBe("D–F");
		});

		it("handles lowercase descriptions", () => {
			const entries = makeEntries([
				{ description: "apple" },
				{ description: "banana" },
			]);
			expect(derivePositionLabel(entries, 0, 1, "description", "asc", defaultFormat)).toBe("A–B");
		});
	});

	describe("sortKey = 'status'", () => {
		it("shows single status", () => {
			const entries = makeEntries([
				{ status: "confirmed" },
				{ status: "confirmed" },
			]);
			expect(derivePositionLabel(entries, 0, 1, "status", "asc", defaultFormat)).toBe("confirmed");
		});

		it("shows status range", () => {
			const entries = makeEntries([
				{ status: "confirmed" },
				{ status: "pending" },
			]);
			expect(derivePositionLabel(entries, 0, 1, "status", "asc", defaultFormat)).toBe(
				"confirmed – pending",
			);
		});
	});

	describe("sortKey = 'amount'", () => {
		it("shows single amount when same", () => {
			const items = makeItems([["100", "USD"]]);
			const itemMap = new Map<string, LineItem[]>();
			itemMap.set("1", items);
			itemMap.set("2", items);
			const entries = [makeEntry({ id: "1" }), makeEntry({ id: "2" })];
			const getItems = (id: string) => itemMap.get(id) ?? [];
			const label = derivePositionLabel(entries, 0, 1, "amount", "asc", defaultFormat, getItems);
			expect(label).toBe("100 USD");
		});

		it("shows amount range", () => {
			const itemMap = new Map<string, LineItem[]>();
			itemMap.set("1", makeItems([["50", "USD"]]));
			itemMap.set("2", makeItems([["200", "EUR"]]));
			const entries = [makeEntry({ id: "1" }), makeEntry({ id: "2" })];
			const getItems = (id: string) => itemMap.get(id) ?? [];
			const label = derivePositionLabel(entries, 0, 1, "amount", "asc", defaultFormat, getItems);
			expect(label).toBe("50 USD – 200 EUR");
		});

		it("uses provided format function", () => {
			const customFormat = () => "$42.00";
			const entries = makeEntries([{}, {}]);
			const label = derivePositionLabel(entries, 0, 1, "amount", "asc", customFormat, () => []);
			expect(label).toBe("$42.00");
		});
	});
});
