// Stellar sync — fetch operations via Horizon and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchOperations } from "./api.js";
import type { StellarAccount, StellarSyncResult, StellarOperation } from "./types.js";

const CHAIN = "Stellar";

/** Extract currency symbol from a Stellar operation's asset fields */
function assetSymbol(op: StellarOperation): string {
	if (op.asset_type === "native" || !op.asset_code) return "XLM";
	return op.asset_code;
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncStellarAccount(
	backend: Backend,
	account: StellarAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<StellarSyncResult> {
	const result: StellarSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch operations
	onProgress?.("Fetching operations...");
	const { operations, endCursor } = await fetchOperations(
		account.address, account.last_cursor ?? undefined, signal,
	);

	if (operations.length === 0) {
		onProgress?.("No new operations found.");
		return result;
	}

	onProgress?.(`Found ${operations.length} operations.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("stellar:")) existingSources.add(e.source);
	}

	// Helpers
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: 7, is_base: false });
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

	// 3. Process operations
	const addr = account.address;

	for (let i = 0; i < operations.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const op = operations[i];
		const source = `stellar:${op.id}`;

		onProgress?.(`Processing ${i + 1}/${operations.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(op)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (!op.transaction_successful) {
			result.transactions_skipped++;
			continue;
		}

		const date = op.created_at
			? new Date(op.created_at).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let mainCurrency = "XLM";
		let direction: "sent" | "received" | "self" = "self";

		if (op.type === "payment" || op.type === "path_payment_strict_receive" || op.type === "path_payment_strict_send") {
			if (!op.amount || !op.from || !op.to) { result.transactions_skipped++; continue; }

			const symbol = assetSymbol(op);
			mainCurrency = symbol;
			const amount = new Decimal(op.amount);
			if (amount.isZero()) { result.transactions_skipped++; continue; }

			await ensureCurrency(symbol);

			const isSender = op.from === addr;
			direction = isSender ? "sent" : "received";

			if (isSender) {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: symbol, amount: amount.neg().toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(op.to)), currency: symbol, amount: amount.toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: symbol, amount: amount.toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(op.from)), currency: symbol, amount: amount.neg().toFixed() },
				);
			}
		} else if (op.type === "create_account") {
			if (!op.starting_balance || !op.funder || !op.account) { result.transactions_skipped++; continue; }

			mainCurrency = "XLM";
			const amount = new Decimal(op.starting_balance);
			if (amount.isZero()) { result.transactions_skipped++; continue; }

			await ensureCurrency("XLM");

			const isFunder = op.funder === addr;
			direction = isFunder ? "sent" : "received";

			if (isFunder) {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "XLM", amount: amount.neg().toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(op.account)), currency: "XLM", amount: amount.toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "XLM", amount: amount.toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(op.funder)), currency: "XLM", amount: amount.neg().toFixed() },
				);
			}
		} else {
			// Skip other operation types for v1
			result.transactions_skipped++;
			continue;
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		const descData = onchainTransferDescription(CHAIN, mainCurrency, direction, { txHash: op.transaction_hash });
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

		const meta: Record<string, string> = {
			"stellar:op_id": op.id,
			"stellar:op_type": op.type,
			"stellar:direction": direction,
			"stellar:asset": mainCurrency,
			"stellar:tx_hash": op.transaction_hash,
		};
		if (op.amount) meta["stellar:amount"] = op.amount;
		if (op.from) meta["stellar:from"] = op.from;
		if (op.to) meta["stellar:to"] = op.to;

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post stellar:${op.id}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	if (endCursor) {
		await backend.updateStellarSyncCursor(account.id, endCursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
