// Zcash sync — fetch transactions via Blockchair and create journal entries (transparent only).

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { ZcashAccount, ZcashSyncResult } from "./types.js";

const CHAIN = "Zcash";
const ZEC_DECIMALS = 8; // 1 ZEC = 10^8 zatoshi

function satoshiToZec(satoshi: number): string {
	return new Decimal(satoshi).div(new Decimal(10).pow(ZEC_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncZcashAccount(
	backend: Backend,
	account: ZcashAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<ZcashSyncResult> {
	const result: ZcashSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions } = await fetchTransactions(account.address, signal);

	if (transactions.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${transactions.length} transactions.`);

	// 2. Build caches
	const newCurrencies: string[] = [];
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("zcash:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		await backend.createCurrency({ code, asset_type: "", param: "", name: code, decimal_places: ZEC_DECIMALS, is_base: false });
		newCurrencies.push(code);
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

	await ensureCurrency("ZEC");

	// 3. Process transactions
	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = transactions[i];
		const source = `zcash:${tx.hash}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (tx.balance_change === 0) {
			result.transactions_skipped++;
			continue;
		}

		const date = tx.time ? new Date(tx.time).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

		const amount = satoshiToZec(Math.abs(tx.balance_change));
		const direction: "sent" | "received" = tx.balance_change > 0 ? "received" : "sent";

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (direction === "received") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "ZEC", amount: amount },
				{ account: walletExternal(CHAIN, shortAddr(account.address)), currency: "ZEC", amount: new Decimal(amount).neg().toFixed() },
			);
		} else {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "ZEC", amount: new Decimal(amount).neg().toFixed() },
				{ account: walletExternal(CHAIN, shortAddr(account.address)), currency: "ZEC", amount: amount },
			);
		}

		const descData = onchainTransferDescription(CHAIN, "ZEC", direction, { txHash: tx.hash });
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
			result.warnings.push(`post ${tx.hash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	// Reclassify newly created currencies as crypto
	for (const code of newCurrencies) {
		const type = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		try { await backend.setCurrencyAssetType(code, type); } catch { /* may already be classified */ }
	}

	return result;
}
