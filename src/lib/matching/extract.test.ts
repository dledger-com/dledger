import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { extractMovement, extractAllCandidates } from "./extract.js";
import type { JournalEntry, LineItem } from "../types/index.js";

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
	const id = uuidv7();
	return {
		id,
		date: "2024-03-15",
		description: "Test entry",
		status: "confirmed",
		source: "manual",
		voided_by: null,
		created_at: "2024-03-15",
		...overrides,
	};
}

function makeItem(entryId: string, accountId: string, currency: string, amount: string): LineItem {
	return {
		id: uuidv7(),
		journal_entry_id: entryId,
		account_id: accountId,
		currency,
		amount,
		lot_id: null,
	};
}

describe("extractMovement", () => {
	it("extracts a simple 2-line entry with suspense counterparty", () => {
		const bankAccId = uuidv7();
		const suspenseAccId = uuidv7();
		const entry = makeEntry({ source: "csv-import:revolut" });
		const items = [
			makeItem(entry.id, bankAccId, "EUR", "500"),
			makeItem(entry.id, suspenseAccId, "EUR", "-500"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[suspenseAccId, "Income:Uncategorized"],
		]);

		const result = extractMovement(entry, items, accountIdToName);
		expect(result).not.toBeNull();
		expect(result!.realAccountName).toBe("Assets:Bank:N26");
		expect(result!.realAccountId).toBe(bankAccId);
		expect(result!.currency).toBe("EUR");
		expect(result!.amount).toBe("500");
		expect(result!.suspenseAccountName).toBe("Income:Uncategorized");
		expect(result!.feeItems).toHaveLength(0);
		expect(result!.otherItems).toHaveLength(0);
	});

	it("extracts entry with fee items", () => {
		const exchangeAccId = uuidv7();
		const suspenseAccId = uuidv7();
		const feeAccId = uuidv7();
		const entry = makeEntry({ source: "cex:kraken:withdrawal" });
		const items = [
			makeItem(entry.id, exchangeAccId, "EUR", "-1000"),
			makeItem(entry.id, suspenseAccId, "EUR", "995"),
			makeItem(entry.id, feeAccId, "EUR", "5"),
		];
		const accountIdToName = new Map([
			[exchangeAccId, "Assets:Crypto:Exchange:Kraken"],
			[suspenseAccId, "Equity:Crypto:Exchange:Kraken:External"],
			[feeAccId, "Expenses:Crypto:Fees:Trading:Kraken"],
		]);

		const result = extractMovement(entry, items, accountIdToName);
		expect(result).not.toBeNull();
		expect(result!.realAccountName).toBe("Assets:Crypto:Exchange:Kraken");
		expect(result!.amount).toBe("-1000");
		expect(result!.feeItems).toHaveLength(1);
		expect(result!.feeItems[0].amount).toBe("5");
	});

	it("returns null for entries with no suspense items", () => {
		const bankAccId = uuidv7();
		const foodAccId = uuidv7();
		const entry = makeEntry();
		const items = [
			makeItem(entry.id, bankAccId, "EUR", "-50"),
			makeItem(entry.id, foodAccId, "EUR", "50"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[foodAccId, "Expenses:Food"],
		]);

		expect(extractMovement(entry, items, accountIdToName)).toBeNull();
	});

	it("returns null for voided entries", () => {
		const bankAccId = uuidv7();
		const suspenseAccId = uuidv7();
		const entry = makeEntry({ voided_by: uuidv7() });
		const items = [
			makeItem(entry.id, bankAccId, "EUR", "500"),
			makeItem(entry.id, suspenseAccId, "EUR", "-500"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[suspenseAccId, "Income:Uncategorized"],
		]);

		expect(extractMovement(entry, items, accountIdToName)).toBeNull();
	});

	it("returns null for multi-currency suspense items", () => {
		const bankAccId = uuidv7();
		const suspAccId1 = uuidv7();
		const suspAccId2 = uuidv7();
		const entry = makeEntry();
		const items = [
			makeItem(entry.id, bankAccId, "EUR", "500"),
			makeItem(entry.id, suspAccId1, "EUR", "-400"),
			makeItem(entry.id, suspAccId2, "USD", "-100"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[suspAccId1, "Income:Uncategorized"],
			[suspAccId2, "Income:Uncategorized"],
		]);

		expect(extractMovement(entry, items, accountIdToName)).toBeNull();
	});
});

describe("extractAllCandidates", () => {
	it("filters out already-linked entries", () => {
		const bankAccId = uuidv7();
		const suspenseAccId = uuidv7();
		const entry1 = makeEntry({ source: "csv-import:revolut" });
		const entry2 = makeEntry({ source: "cex:kraken" });
		const items1 = [
			makeItem(entry1.id, bankAccId, "EUR", "500"),
			makeItem(entry1.id, suspenseAccId, "EUR", "-500"),
		];
		const items2 = [
			makeItem(entry2.id, bankAccId, "EUR", "-500"),
			makeItem(entry2.id, suspenseAccId, "EUR", "500"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[suspenseAccId, "Income:Uncategorized"],
		]);

		const alreadyLinked = new Set([entry1.id]);
		const result = extractAllCandidates(
			[[entry1, items1], [entry2, items2]],
			accountIdToName,
			alreadyLinked,
		);
		expect(result).toHaveLength(1);
		expect(result[0].entry.id).toBe(entry2.id);
	});

	it("returns empty for entries with no suspense accounts", () => {
		const bankAccId = uuidv7();
		const foodAccId = uuidv7();
		const entry = makeEntry();
		const items = [
			makeItem(entry.id, bankAccId, "EUR", "-50"),
			makeItem(entry.id, foodAccId, "EUR", "50"),
		];
		const accountIdToName = new Map([
			[bankAccId, "Assets:Bank:N26"],
			[foodAccId, "Expenses:Food"],
		]);

		const result = extractAllCandidates([[entry, items]], accountIdToName, new Set());
		expect(result).toHaveLength(0);
	});
});
