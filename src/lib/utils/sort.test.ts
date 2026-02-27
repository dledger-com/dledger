import { describe, it, expect } from "vitest";
import { sortItems, parseCurrencyForSort } from "./sort.js";
import { createSortState } from "./sort.svelte.js";

describe("createSortState", () => {
	it("starts with null key and direction", () => {
		const sort = createSortState<"a" | "b">();
		expect(sort.key).toBe(null);
		expect(sort.direction).toBe(null);
	});

	it("cycles: null → asc → desc → null", () => {
		const sort = createSortState<"col">();

		sort.toggle("col");
		expect(sort.key).toBe("col");
		expect(sort.direction).toBe("asc");

		sort.toggle("col");
		expect(sort.key).toBe("col");
		expect(sort.direction).toBe("desc");

		sort.toggle("col");
		expect(sort.key).toBe(null);
		expect(sort.direction).toBe(null);
	});

	it("switches to new key with asc", () => {
		const sort = createSortState<"a" | "b">();

		sort.toggle("a");
		expect(sort.key).toBe("a");
		expect(sort.direction).toBe("asc");

		sort.toggle("b");
		expect(sort.key).toBe("b");
		expect(sort.direction).toBe("asc");
	});

	it("reset clears state", () => {
		const sort = createSortState<"x">();
		sort.toggle("x");
		expect(sort.key).toBe("x");

		sort.reset();
		expect(sort.key).toBe(null);
		expect(sort.direction).toBe(null);
	});
});

describe("sortItems", () => {
	it("sorts strings ascending", () => {
		const items = [{ name: "Charlie" }, { name: "Alice" }, { name: "Bob" }];
		const result = sortItems(items, (i) => i.name, "asc");
		expect(result.map((i) => i.name)).toEqual(["Alice", "Bob", "Charlie"]);
	});

	it("sorts strings descending", () => {
		const items = [{ name: "Charlie" }, { name: "Alice" }, { name: "Bob" }];
		const result = sortItems(items, (i) => i.name, "desc");
		expect(result.map((i) => i.name)).toEqual(["Charlie", "Bob", "Alice"]);
	});

	it("sorts numbers ascending", () => {
		const items = [{ val: 30 }, { val: 10 }, { val: 20 }];
		const result = sortItems(items, (i) => i.val, "asc");
		expect(result.map((i) => i.val)).toEqual([10, 20, 30]);
	});

	it("sorts numbers descending", () => {
		const items = [{ val: 30 }, { val: 10 }, { val: 20 }];
		const result = sortItems(items, (i) => i.val, "desc");
		expect(result.map((i) => i.val)).toEqual([30, 20, 10]);
	});

	it("sorts strings with numeric option (natural sort)", () => {
		const items = [{ name: "item10" }, { name: "item2" }, { name: "item1" }];
		const result = sortItems(items, (i) => i.name, "asc");
		expect(result.map((i) => i.name)).toEqual(["item1", "item2", "item10"]);
	});

	it("places nulls last regardless of direction", () => {
		const items = [{ val: null as number | null }, { val: 1 }, { val: 3 }, { val: null as number | null }, { val: 2 }];
		const asc = sortItems(items, (i) => i.val, "asc");
		expect(asc.map((i) => i.val)).toEqual([1, 2, 3, null, null]);

		const desc = sortItems(items, (i) => i.val, "desc");
		expect(desc.map((i) => i.val)).toEqual([3, 2, 1, null, null]);
	});

	it("places empty strings last", () => {
		const items = [{ name: "" }, { name: "B" }, { name: "A" }];
		const result = sortItems(items, (i) => i.name, "asc");
		expect(result.map((i) => i.name)).toEqual(["A", "B", ""]);
	});

	it("does not mutate original array", () => {
		const items = [{ val: 3 }, { val: 1 }, { val: 2 }];
		const original = [...items];
		sortItems(items, (i) => i.val, "asc");
		expect(items).toEqual(original);
	});

	it("handles empty array", () => {
		const result = sortItems([], (i: { val: number }) => i.val, "asc");
		expect(result).toEqual([]);
	});

	it("sorts dates as strings correctly", () => {
		const items = [{ date: "2024-03-15" }, { date: "2024-01-01" }, { date: "2024-12-31" }];
		const result = sortItems(items, (i) => i.date, "asc");
		expect(result.map((i) => i.date)).toEqual(["2024-01-01", "2024-03-15", "2024-12-31"]);
	});
});

describe("parseCurrencyForSort", () => {
	it('parses "$1,234.56"', () => {
		expect(parseCurrencyForSort("$1,234.56")).toBeCloseTo(1234.56);
	});

	it('parses "-500.00"', () => {
		expect(parseCurrencyForSort("-500.00")).toBeCloseTo(-500);
	});

	it('parses European "1 203,55"', () => {
		expect(parseCurrencyForSort("1 203,55")).toBeCloseTo(1203.55);
	});

	it('parses "+$500.00 EUR"', () => {
		expect(parseCurrencyForSort("+$500.00 EUR")).toBeCloseTo(500);
	});

	it('parses "1.203,55" (European with dot thousands)', () => {
		expect(parseCurrencyForSort("1.203,55")).toBeCloseTo(1203.55);
	});

	it("returns 0 for empty string", () => {
		expect(parseCurrencyForSort("")).toBe(0);
	});

	it("returns 0 for non-numeric string", () => {
		expect(parseCurrencyForSort("N/A")).toBe(0);
	});

	it('parses negative currency "-$1,234.56"', () => {
		expect(parseCurrencyForSort("-$1,234.56")).toBeCloseTo(-1234.56);
	});

	it('parses simple integer "42"', () => {
		expect(parseCurrencyForSort("42")).toBe(42);
	});
});
