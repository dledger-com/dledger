// Sui sync — fetch transactions via GraphQL and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { SuiAccount, SuiSyncResult, SuiTransactionNode, SuiBalanceChange } from "./types.js";

const CHAIN = "Sui";

/** Extract a short coin symbol from a full Sui coin type (e.g., "0x2::sui::SUI" → "SUI") */
function coinSymbol(coinType: string): string {
	const parts = coinType.split("::");
	return parts[parts.length - 1] ?? coinType;
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncSuiAccount(
	backend: Backend,
	account: SuiAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<SuiSyncResult> {
	const result: SuiSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { nodes, endCursor } = await fetchTransactions(account.address, account.last_cursor ?? undefined, signal);

	if (nodes.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${nodes.length} transactions.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("sui:")) existingSources.add(e.source);
	}

	// Helpers (same pattern as Solana/Hyperliquid)
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: 9, is_base: false });
		currencySet.add(code);
	}

	function inferAccountType(fullName: string): "asset" | "liability" | "equity" | "revenue" | "expense" {
		const first = fullName.split(":")[0];
		switch (first) {
			case "Assets": return "asset";
			case "Liabilities": return "liability";
			case "Equity": return "equity";
			case "Income": return "revenue";
			case "Expenses": return "expense";
			default: return "expense";
		}
	}

	async function ensureAccount(fullName: string, date: string): Promise<string> {
		const existing = accountMap.get(fullName);
		if (existing) return existing.id;
		const parts = fullName.split(":");
		let parentId: string | null = null;
		for (let depth = 1; depth < parts.length; depth++) {
			const ancestorName = parts.slice(0, depth).join(":");
			const ancestor = accountMap.get(ancestorName);
			if (ancestor) { parentId = ancestor.id; } else {
				const id = uuidv7();
				const acc: Account = { id, parent_id: parentId, account_type: inferAccountType(fullName), name: parts[depth - 1], full_name: ancestorName, allowed_currencies: [], is_postable: true, is_archived: false, created_at: date };
				await backend.createAccount(acc);
				accountMap.set(ancestorName, acc);
				result.accounts_created++;
				parentId = id;
			}
		}
		const id = uuidv7();
		const acc: Account = { id, parent_id: parentId, account_type: inferAccountType(fullName), name: parts[parts.length - 1], full_name: fullName, allowed_currencies: [], is_postable: true, is_archived: false, created_at: date };
		await backend.createAccount(acc);
		accountMap.set(fullName, acc);
		result.accounts_created++;
		return id;
	}

	// 3. Process transactions
	const addr = account.address.toLowerCase();

	for (let i = 0; i < nodes.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = nodes[i];
		const source = `sui:${tx.digest}`;

		onProgress?.(`Processing ${i + 1}/${nodes.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (tx.effects.status !== "SUCCESS") {
			result.transactions_skipped++;
			continue;
		}

		const date = tx.effects.timestamp
			? new Date(tx.effects.timestamp).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		// Filter balance changes for our address
		const myChanges = tx.effects.balanceChanges.nodes.filter(
			(bc) => bc.owner?.asAddress?.address?.toLowerCase() === addr,
		);

		if (myChanges.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		// Build line items from balance changes
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		for (const change of myChanges) {
			const symbol = coinSymbol(change.coinType.repr);
			const amount = new Decimal(change.amount);
			if (amount.isZero()) continue;

			await ensureCurrency(symbol);

			// Asset line: positive = received, negative = sent
			lineItemData.push({
				account: walletAssets(CHAIN, account.label),
				currency: symbol,
				amount: amount.toFixed(),
			});

			// Counterparty equity line
			lineItemData.push({
				account: walletExternal(CHAIN, shortAddr(account.address)),
				currency: symbol,
				amount: amount.neg().toFixed(),
			});
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		// Determine description
		const mainChange = myChanges.find(c => !new Decimal(c.amount).isZero());
		const mainSymbol = mainChange ? coinSymbol(mainChange.coinType.repr) : "SUI";
		const netAmount = mainChange ? new Decimal(mainChange.amount) : new Decimal(0);
		const direction = netAmount.gt(0) ? "received" as const : netAmount.lt(0) ? "sent" as const : "self" as const;

		const descData = onchainTransferDescription(CHAIN, mainSymbol, direction, { txHash: tx.digest });
		const description = renderDescription(descData);

		const entryId = uuidv7();
		const entry: JournalEntry = {
			id: entryId, date, description,
			description_data: JSON.stringify(descData),
			status: "confirmed", source, voided_by: null, created_at: date,
		};

		const lineItems: LineItem[] = [];
		for (const item of lineItemData) {
			const accountId = await ensureAccount(item.account, date);
			lineItems.push({ id: uuidv7(), journal_entry_id: entryId, account_id: accountId, currency: item.currency, amount: item.amount, lot_id: null });
		}

		try {
			await backend.postJournalEntry(entry, lineItems);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${tx.digest.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	if (endCursor) {
		await backend.updateSuiSyncCursor(account.id, endCursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
