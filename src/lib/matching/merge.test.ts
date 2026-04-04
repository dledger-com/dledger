import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { extractMovement } from "./extract.js";
import { findMatches } from "./score.js";
import { mergeMatchedPair, mergeAllMatches } from "./merge.js";
import type { MatchCandidate } from "./types.js";

async function setupTestScenario() {
	const backend = await createTestBackend();

	// Create currencies
	await backend.createCurrency({ code: "EUR", asset_type: "", name: "Euro", decimal_places: 2 });

	// Create accounts
	const accounts: Record<string, Account> = {};
	const accountDefs: Array<[string, string, string | null, string]> = [
		["Assets", "asset", null, "Assets"],
		["Assets:Crypto", "asset", "Assets", "Crypto"],
		["Assets:Crypto:Exchange", "asset", "Assets:Crypto", "Exchange"],
		["Assets:Crypto:Exchange:Kraken", "asset", "Assets:Crypto:Exchange", "Kraken"],
		["Assets:Bank", "asset", "Assets", "Bank"],
		["Assets:Bank:N26", "asset", "Assets:Bank", "N26"],
		["Equity", "equity", null, "Equity"],
		["Equity:Crypto", "equity", "Equity", "Crypto"],
		["Equity:Crypto:Exchange", "equity", "Equity:Crypto", "Exchange"],
		["Equity:Crypto:Exchange:Kraken", "equity", "Equity:Crypto:Exchange", "Kraken"],
		["Equity:Crypto:Exchange:Kraken:External", "equity", "Equity:Crypto:Exchange:Kraken", "External"],
		["Income", "revenue", null, "Income"],
		["Income:Uncategorized", "revenue", "Income", "Uncategorized"],
		["Expenses", "expense", null, "Expenses"],
		["Expenses:Crypto", "expense", "Expenses", "Crypto"],
		["Expenses:Crypto:Fees", "expense", "Expenses:Crypto", "Fees"],
		["Expenses:Crypto:Fees:Trading", "expense", "Expenses:Crypto:Fees", "Trading"],
		["Expenses:Crypto:Fees:Trading:Kraken", "expense", "Expenses:Crypto:Fees:Trading", "Kraken"],
	];

	for (const [fullName, accType, parentFullName, name] of accountDefs) {
		const id = uuidv7();
		const parentId = parentFullName ? accounts[parentFullName].id : null;
		accounts[fullName] = {
			id,
			parent_id: parentId,
			account_type: accType as Account["account_type"],
			name,
			full_name: fullName,
			allowed_currencies: [],
			is_postable: true,
			is_archived: false,
			created_at: "2024-01-01",
		};
		await backend.createAccount(accounts[fullName]);
	}

	const accountIdToName = new Map<string, string>();
	const accountMap = new Map<string, Account>();
	for (const [fullName, acc] of Object.entries(accounts)) {
		accountIdToName.set(acc.id, fullName);
		accountMap.set(fullName, acc);
	}

	return { backend, accounts, accountIdToName, accountMap };
}

function postEntry(
	backend: ReturnType<typeof createTestBackend> extends Promise<infer T> ? T : never,
	entry: JournalEntry,
	items: LineItem[],
) {
	return backend.postJournalEntry(entry, items);
}

describe("mergeMatchedPair", () => {
	it("merges a CEX withdrawal with a bank deposit", async () => {
		const { backend, accounts, accountIdToName, accountMap } = await setupTestScenario();

		// CEX withdrawal: -1000 EUR from exchange, +1000 to external equity
		const cexEntry: JournalEntry = {
			id: uuidv7(), date: "2024-03-14",
			description: "Kraken withdrawal: 1000 EUR",
			status: "confirmed", source: "cex:kraken:withdrawal",
			voided_by: null, created_at: "2024-03-14",
		};
		const cexItems: LineItem[] = [
			{ id: uuidv7(), journal_entry_id: cexEntry.id, account_id: accounts["Assets:Crypto:Exchange:Kraken"].id, currency: "EUR", amount: "-1000", lot_id: null },
			{ id: uuidv7(), journal_entry_id: cexEntry.id, account_id: accounts["Equity:Crypto:Exchange:Kraken:External"].id, currency: "EUR", amount: "1000", lot_id: null },
		];
		await postEntry(backend, cexEntry, cexItems);

		// Bank deposit: +1000 EUR to bank, -1000 from uncategorized
		const bankEntry: JournalEntry = {
			id: uuidv7(), date: "2024-03-15",
			description: "Incoming transfer",
			status: "confirmed", source: "pdf-n26",
			voided_by: null, created_at: "2024-03-15",
		};
		const bankItems: LineItem[] = [
			{ id: uuidv7(), journal_entry_id: bankEntry.id, account_id: accounts["Assets:Bank:N26"].id, currency: "EUR", amount: "1000", lot_id: null },
			{ id: uuidv7(), journal_entry_id: bankEntry.id, account_id: accounts["Income:Uncategorized"].id, currency: "EUR", amount: "-1000", lot_id: null },
		];
		await postEntry(backend, bankEntry, bankItems);

		// Extract movements
		const movA = extractMovement(cexEntry, cexItems, accountIdToName)!;
		const movB = extractMovement(bankEntry, bankItems, accountIdToName)!;
		expect(movA).not.toBeNull();
		expect(movB).not.toBeNull();

		const match: MatchCandidate = {
			movementA: movA,
			movementB: movB,
			confidence: "high",
			score: 80,
			matchedCurrency: "EUR",
			amountDifferencePercent: 0,
			dateDifferenceDays: 1,
			hasReconciledItems: false,
		};

		const { entryId, warning } = await mergeMatchedPair(backend, match, accountMap);
		expect(entryId).toBeTruthy();
		expect(warning).toBeUndefined();

		// Both originals should be voided
		const voidedCex = await backend.getJournalEntry(cexEntry.id);
		expect(voidedCex![0].voided_by).toBeTruthy();
		const voidedBank = await backend.getJournalEntry(bankEntry.id);
		expect(voidedBank![0].voided_by).toBeTruthy();

		// New merged entry should exist
		const merged = await backend.getJournalEntry(entryId);
		expect(merged).not.toBeNull();
		expect(merged![0].date).toBe("2024-03-14"); // earlier date
		expect(merged![0].source).toBe("matched:cex:kraken:withdrawal+pdf-n26");

		// Line items: exchange account (-1000) + bank account (+1000)
		const mergedItems = merged![1];
		expect(mergedItems).toHaveLength(2);
		const exchangeItem = mergedItems.find((i: LineItem) => i.account_id === accounts["Assets:Crypto:Exchange:Kraken"].id);
		const bankItem = mergedItems.find((i: LineItem) => i.account_id === accounts["Assets:Bank:N26"].id);
		expect(exchangeItem!.amount).toBe("-1000");
		expect(bankItem!.amount).toBe("1000");

		// Metadata should be set
		const meta = await backend.getMetadata(entryId);
		expect(meta["cross_match_linked"]).toBe("true");
		expect(meta["cross_match_source_a"]).toBe("cex:kraken:withdrawal");
		expect(meta["cross_match_source_b"]).toBe("pdf-n26");
	});

	it("books imbalance to transfer fees", async () => {
		const { backend, accounts, accountIdToName, accountMap } = await setupTestScenario();

		// CEX withdrawal: -1000 EUR + 5 EUR fee
		const cexEntry: JournalEntry = {
			id: uuidv7(), date: "2024-03-15",
			description: "Kraken withdrawal: 1000 EUR",
			status: "confirmed", source: "cex:kraken:withdrawal",
			voided_by: null, created_at: "2024-03-15",
		};
		const cexItems: LineItem[] = [
			{ id: uuidv7(), journal_entry_id: cexEntry.id, account_id: accounts["Assets:Crypto:Exchange:Kraken"].id, currency: "EUR", amount: "-1000", lot_id: null },
			{ id: uuidv7(), journal_entry_id: cexEntry.id, account_id: accounts["Equity:Crypto:Exchange:Kraken:External"].id, currency: "EUR", amount: "995", lot_id: null },
			{ id: uuidv7(), journal_entry_id: cexEntry.id, account_id: accounts["Expenses:Crypto:Fees:Trading:Kraken"].id, currency: "EUR", amount: "5", lot_id: null },
		];
		await postEntry(backend, cexEntry, cexItems);

		// Bank deposit: only 990 EUR received (bank also took a fee)
		const bankEntry: JournalEntry = {
			id: uuidv7(), date: "2024-03-15",
			description: "Incoming transfer",
			status: "confirmed", source: "pdf-n26",
			voided_by: null, created_at: "2024-03-15",
		};
		const bankItems: LineItem[] = [
			{ id: uuidv7(), journal_entry_id: bankEntry.id, account_id: accounts["Assets:Bank:N26"].id, currency: "EUR", amount: "990", lot_id: null },
			{ id: uuidv7(), journal_entry_id: bankEntry.id, account_id: accounts["Income:Uncategorized"].id, currency: "EUR", amount: "-990", lot_id: null },
		];
		await postEntry(backend, bankEntry, bankItems);

		const movA = extractMovement(cexEntry, cexItems, accountIdToName)!;
		const movB = extractMovement(bankEntry, bankItems, accountIdToName)!;

		const match: MatchCandidate = {
			movementA: movA,
			movementB: movB,
			confidence: "high",
			score: 75,
			matchedCurrency: "EUR",
			amountDifferencePercent: 1,
			dateDifferenceDays: 0,
			hasReconciledItems: false,
		};

		const { entryId, warning } = await mergeMatchedPair(backend, match, accountMap);
		expect(entryId).toBeTruthy();
		// -1000 + 990 + 5 = -5, so 5 EUR booked to transfer fees
		expect(warning).toContain("Imbalance");
		expect(warning).toContain("Expenses:Fees:Transfer");

		const merged = await backend.getJournalEntry(entryId);
		const mergedItems = merged![1];
		// exchange (-1000) + bank (990) + exchange fee (5) + transfer fee (5)
		expect(mergedItems).toHaveLength(4);
		// Verify the entry balances to zero
		const total = mergedItems.reduce((s: number, i: LineItem) => s + parseFloat(i.amount), 0);
		expect(total).toBeCloseTo(0, 2);
		// Verify the known accounts exist
		const accountIds = mergedItems.map((i: LineItem) => i.account_id);
		expect(accountIds).toContain(accounts["Assets:Crypto:Exchange:Kraken"].id);
		expect(accountIds).toContain(accounts["Assets:Bank:N26"].id);
		expect(accountIds).toContain(accounts["Expenses:Crypto:Fees:Trading:Kraken"].id);
	});
});

describe("mergeAllMatches", () => {
	it("merges multiple pairs and reports progress", async () => {
		const { backend, accounts, accountIdToName, accountMap } = await setupTestScenario();

		// Create two separate transfer pairs
		const entries: Array<{ entry: JournalEntry; items: LineItem[] }> = [];

		// Pair 1: 1000 EUR
		const e1 = { id: uuidv7(), date: "2024-03-15", description: "Withdrawal 1", status: "confirmed" as const, source: "cex:kraken:withdrawal", voided_by: null, created_at: "2024-03-15" };
		const i1 = [
			{ id: uuidv7(), journal_entry_id: e1.id, account_id: accounts["Assets:Crypto:Exchange:Kraken"].id, currency: "EUR", amount: "-1000", lot_id: null },
			{ id: uuidv7(), journal_entry_id: e1.id, account_id: accounts["Equity:Crypto:Exchange:Kraken:External"].id, currency: "EUR", amount: "1000", lot_id: null },
		];
		await postEntry(backend, e1, i1);
		entries.push({ entry: e1, items: i1 });

		const e2 = { id: uuidv7(), date: "2024-03-15", description: "Deposit 1", status: "confirmed" as const, source: "pdf-n26", voided_by: null, created_at: "2024-03-15" };
		const i2 = [
			{ id: uuidv7(), journal_entry_id: e2.id, account_id: accounts["Assets:Bank:N26"].id, currency: "EUR", amount: "1000", lot_id: null },
			{ id: uuidv7(), journal_entry_id: e2.id, account_id: accounts["Income:Uncategorized"].id, currency: "EUR", amount: "-1000", lot_id: null },
		];
		await postEntry(backend, e2, i2);
		entries.push({ entry: e2, items: i2 });

		// Extract and match
		const candidates = entries.map((e) =>
			extractMovement(e.entry, e.items, accountIdToName),
		).filter((m) => m !== null);

		const matches = findMatches(candidates, new Map());
		expect(matches).toHaveLength(1);

		const progressUpdates: Array<{ current: number; total: number }> = [];
		const result = await mergeAllMatches(backend, matches, accountMap, {
			onProgress: (p) => progressUpdates.push({ current: p.current, total: p.total }),
		});

		expect(result.matched).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.mergedEntryIds).toHaveLength(1);
		expect(progressUpdates.length).toBeGreaterThan(0);
	});
});
