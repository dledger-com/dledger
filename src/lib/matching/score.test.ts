import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { findMatches } from "./score.js";
import type { EntryMovement } from "./types.js";
import type { JournalEntry } from "../types/index.js";

function makeMovement(overrides: Partial<{
	date: string;
	source: string;
	currency: string;
	amount: string;
	realAccountName: string;
	suspenseAccountName: string;
}>): EntryMovement {
	const entryId = uuidv7();
	const entry: JournalEntry = {
		id: entryId,
		date: overrides.date ?? "2024-03-15",
		description: "Test",
		status: "confirmed",
		source: overrides.source ?? "manual",
		voided_by: null,
		created_at: "2024-03-15",
	};

	return {
		entry,
		items: [],
		realAccountName: overrides.realAccountName ?? "Assets:Bank:N26",
		realAccountId: uuidv7(),
		currency: overrides.currency ?? "EUR",
		amount: overrides.amount ?? "500",
		suspenseAccountName: overrides.suspenseAccountName ?? "Income:Uncategorized",
		suspenseAccountId: uuidv7(),
		feeItems: [],
		otherItems: [],
	};
}

describe("findMatches", () => {
	it("matches exact amount + same day from different sources", () => {
		const a = makeMovement({ source: "cex:kraken:withdrawal", amount: "-1000", date: "2024-03-15" });
		const b = makeMovement({ source: "pdf-n26", amount: "1000", date: "2024-03-15" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(1);
		expect(matches[0].score).toBe(80); // 50 (exact amount) + 30 (same day)
		expect(matches[0].confidence).toBe("high");
		expect(matches[0].amountDifferencePercent).toBe(0);
		expect(matches[0].dateDifferenceDays).toBe(0);
	});

	it("scores txid match bonus", () => {
		const a = makeMovement({ source: "cex:kraken:withdrawal", amount: "-500", date: "2024-03-15" });
		const b = makeMovement({ source: "csv-import:n26", amount: "500", date: "2024-03-15" });

		const metadataMap = new Map<string, Record<string, string>>([
			[a.entry.id, { txid: "0xabc123" }],
			[b.entry.id, { txid: "0xABC123" }],
		]);

		const matches = findMatches([a, b], metadataMap);
		expect(matches).toHaveLength(1);
		expect(matches[0].score).toBe(100); // 50 + 30 + 20
		expect(matches[0].confidence).toBe("high");
	});

	it("matches with date offset and close amounts", () => {
		const a = makeMovement({ source: "cex:binance", amount: "-990", date: "2024-03-13" });
		const b = makeMovement({ source: "pdf-n26", amount: "1000", date: "2024-03-15" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(1);
		// Amount diff = 1% → 45 points, date diff = 2 days → 20 points
		expect(matches[0].score).toBe(65);
		expect(matches[0].confidence).toBe("medium");
	});

	it("rejects same-source pairs", () => {
		const a = makeMovement({ source: "pdf-n26", amount: "-500" });
		const b = makeMovement({ source: "pdf-n26", amount: "500" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(0);
	});

	it("rejects pairs with different currencies", () => {
		const a = makeMovement({ source: "cex:kraken", currency: "EUR", amount: "-500" });
		const b = makeMovement({ source: "pdf-n26", currency: "USD", amount: "500" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(0);
	});

	it("rejects same-direction pairs", () => {
		const a = makeMovement({ source: "cex:kraken", amount: "500" });
		const b = makeMovement({ source: "pdf-n26", amount: "500" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(0);
	});

	it("rejects pairs with date > 7 days apart", () => {
		const a = makeMovement({ source: "cex:kraken", amount: "-500", date: "2024-03-01" });
		const b = makeMovement({ source: "pdf-n26", amount: "500", date: "2024-03-10" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(0);
	});

	it("rejects pairs with amount > 10% difference", () => {
		const a = makeMovement({ source: "cex:kraken", amount: "-500", date: "2024-03-15" });
		const b = makeMovement({ source: "pdf-n26", amount: "600", date: "2024-03-15" });

		const matches = findMatches([a, b], new Map());
		expect(matches).toHaveLength(0);
	});

	it("uses greedy best-match assignment (no double-matching)", () => {
		const a = makeMovement({ source: "cex:kraken", amount: "-1000", date: "2024-03-15" });
		const b1 = makeMovement({ source: "pdf-n26", amount: "1000", date: "2024-03-15" });
		const b2 = makeMovement({ source: "csv-import:revolut", amount: "1000", date: "2024-03-15" });

		const matches = findMatches([a, b1, b2], new Map());
		// a can only match one of b1/b2
		expect(matches).toHaveLength(1);
	});

	it("sorts matches by confidence then score", () => {
		const a1 = makeMovement({ source: "cex:kraken", amount: "-1000", date: "2024-03-15" });
		const b1 = makeMovement({ source: "pdf-n26", amount: "1000", date: "2024-03-15" });
		const a2 = makeMovement({ source: "cex:binance", amount: "-500", date: "2024-03-10" });
		const b2 = makeMovement({ source: "csv-import:revolut", amount: "480", date: "2024-03-15" });

		const matches = findMatches([a1, b1, a2, b2], new Map());
		expect(matches.length).toBe(2);
		// First match should be the high-confidence one (exact amount + same day)
		expect(matches[0].confidence).toBe("high");
	});
});
