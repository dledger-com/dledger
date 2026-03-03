import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import type { Account, Currency, JournalEntry, LineItem } from "$lib/types/index.js";

async function setupExchangeAccounts(backend: Awaited<ReturnType<typeof createTestBackend>>) {
	// Create currencies
	const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true };
	const BTC: Currency = { code: "BTC", asset_type: "", param: "", name: "Bitcoin", decimal_places: 8, is_base: false };
	await backend.createCurrency(USD);
	await backend.createCurrency(BTC);

	// Create account hierarchy: Assets > Assets:Crypto > Assets:Crypto:Exchange > Assets:Crypto:Exchange:Kraken
	const assetsId = uuidv7();
	await backend.createAccount({
		id: assetsId, parent_id: null, account_type: "asset",
		name: "Assets", full_name: "Assets",
		allowed_currencies: [], is_postable: false, is_archived: false,
		created_at: "2024-01-01",
	});

	const cryptoId = uuidv7();
	await backend.createAccount({
		id: cryptoId, parent_id: assetsId, account_type: "asset",
		name: "Crypto", full_name: "Assets:Crypto",
		allowed_currencies: [], is_postable: false, is_archived: false,
		created_at: "2024-01-01",
	});

	const exchangeId = uuidv7();
	await backend.createAccount({
		id: exchangeId, parent_id: cryptoId, account_type: "asset",
		name: "Exchange", full_name: "Assets:Crypto:Exchange",
		allowed_currencies: [], is_postable: false, is_archived: false,
		created_at: "2024-01-01",
	});

	const krakenId = uuidv7();
	await backend.createAccount({
		id: krakenId, parent_id: exchangeId, account_type: "asset",
		name: "Kraken", full_name: "Assets:Crypto:Exchange:Kraken",
		allowed_currencies: [], is_postable: true, is_archived: false,
		created_at: "2024-01-01",
	});

	const krakenBtcId = uuidv7();
	await backend.createAccount({
		id: krakenBtcId, parent_id: krakenId, account_type: "asset",
		name: "BTC", full_name: "Assets:Crypto:Exchange:Kraken:BTC",
		allowed_currencies: [], is_postable: true, is_archived: false,
		created_at: "2024-01-01",
	});

	// Create equity account for transactions
	const equityId = uuidv7();
	await backend.createAccount({
		id: equityId, parent_id: null, account_type: "equity",
		name: "Equity", full_name: "Equity",
		allowed_currencies: [], is_postable: false, is_archived: false,
		created_at: "2024-01-01",
	});
	const openingId = uuidv7();
	await backend.createAccount({
		id: openingId, parent_id: equityId, account_type: "equity",
		name: "Opening", full_name: "Equity:Opening",
		allowed_currencies: [], is_postable: true, is_archived: false,
		created_at: "2024-01-01",
	});

	// Post a journal entry with line items referencing krakenBtcId
	const entryId = uuidv7();
	const entry: JournalEntry = {
		id: entryId, date: "2024-06-01", description: "Buy BTC",
		status: "confirmed", source: "manual", voided_by: null,
		created_at: "2024-06-01",
	};
	const items: LineItem[] = [
		{ id: uuidv7(), journal_entry_id: entryId, account_id: krakenBtcId, currency: "BTC", amount: "1.5", lot_id: null },
		{ id: uuidv7(), journal_entry_id: entryId, account_id: openingId, currency: "BTC", amount: "-1.5", lot_id: null },
	];
	await backend.postJournalEntry(entry, items);

	return { krakenBtcId, openingId, entryId };
}

describe("renameAccountPrefix", () => {
	it("renames a simple prefix", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		const result = await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		expect(result.renamed).toBe(3); // Exchange + Kraken + Kraken:BTC
		expect(result.skipped).toBe(0);

		const accounts = await backend.listAccounts();
		const names = accounts.map((a) => a.full_name);
		expect(names).toContain("Assets:Exchanges:Kraken");
		expect(names).toContain("Assets:Exchanges:Kraken:BTC");
		expect(names).not.toContain("Assets:Crypto:Exchange:Kraken");
		expect(names).not.toContain("Assets:Crypto:Exchange:Kraken:BTC");
	});

	it("updates full_name, name, and parent_id correctly", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		const accounts = await backend.listAccounts();
		const kraken = accounts.find((a) => a.full_name === "Assets:Exchanges:Kraken");
		expect(kraken).toBeDefined();
		expect(kraken!.name).toBe("Kraken");
		expect(kraken!.account_type).toBe("asset");

		const krakenBtc = accounts.find((a) => a.full_name === "Assets:Exchanges:Kraken:BTC");
		expect(krakenBtc).toBeDefined();
		expect(krakenBtc!.name).toBe("BTC");
		expect(krakenBtc!.parent_id).toBe(kraken!.id);
	});

	it("line items still reference correct account IDs (unchanged)", async () => {
		const backend = await createTestBackend();
		const { krakenBtcId, entryId } = await setupExchangeAccounts(backend);

		await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		// The line item should still reference the same account ID
		const result = await backend.getJournalEntry(entryId);
		expect(result).not.toBeNull();
		const [, lineItems] = result!;
		const btcItem = lineItems.find((li) => li.account_id === krakenBtcId);
		expect(btcItem).toBeDefined();

		// The account should now have the new name but same ID
		const account = await backend.getAccount(krakenBtcId);
		expect(account).not.toBeNull();
		expect(account!.full_name).toBe("Assets:Exchanges:Kraken:BTC");
	});

	it("cleans up orphaned intermediate accounts", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		const accounts = await backend.listAccounts();
		const names = accounts.map((a) => a.full_name);
		// The old "Assets:Crypto:Exchange" intermediate should be gone
		expect(names).not.toContain("Assets:Crypto:Exchange");
		// But "Assets:Crypto" might still exist if it has no children (it does get cleaned up)
		// "Assets" should still exist as it's a parent of "Assets:Exchanges"
		expect(names).toContain("Assets");
	});

	it("skips when target account already exists", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		// Manually create the target account
		const existingId = uuidv7();
		const assets = (await backend.listAccounts()).find((a) => a.full_name === "Assets")!;
		const exchangesId = uuidv7();
		await backend.createAccount({
			id: exchangesId, parent_id: assets.id, account_type: "asset",
			name: "Exchanges", full_name: "Assets:Exchanges",
			allowed_currencies: [], is_postable: false, is_archived: false,
			created_at: "2024-01-01",
		});
		await backend.createAccount({
			id: existingId, parent_id: exchangesId, account_type: "asset",
			name: "Kraken", full_name: "Assets:Exchanges:Kraken",
			allowed_currencies: [], is_postable: true, is_archived: false,
			created_at: "2024-01-01",
		});

		const result = await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		// Exchange + Kraken were skipped (already exist), Kraken:BTC should be renamed
		expect(result.skipped).toBe(2);
		expect(result.renamed).toBe(1);
	});

	it("returns 0/0 when no accounts match the prefix", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		const result = await backend.renameAccountPrefix(
			"Assets:NonExistent",
			"Assets:Something",
		);

		expect(result.renamed).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("returns 0/0 when old and new prefix are the same", async () => {
		const backend = await createTestBackend();
		await setupExchangeAccounts(backend);

		const result = await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Crypto:Exchange",
		);

		expect(result.renamed).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("preserves balances after rename", async () => {
		const backend = await createTestBackend();
		const { krakenBtcId } = await setupExchangeAccounts(backend);

		// Check balance before
		const balanceBefore = await backend.getAccountBalance(krakenBtcId);
		expect(balanceBefore).toHaveLength(1);
		expect(balanceBefore[0].amount).toBe("1.5");

		await backend.renameAccountPrefix(
			"Assets:Crypto:Exchange",
			"Assets:Exchanges",
		);

		// Balance should be the same (same account ID)
		const balanceAfter = await backend.getAccountBalance(krakenBtcId);
		expect(balanceAfter).toHaveLength(1);
		expect(balanceAfter[0].amount).toBe("1.5");
	});
});
