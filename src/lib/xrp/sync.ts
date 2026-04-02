// XRP sync — fetch transactions via JSON-RPC and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { XrpAccount, XrpSyncResult, XrpTransaction, XrpIssuedAmount } from "./types.js";

const CHAIN = "XRP Ledger";
const DROPS_PER_XRP = 1_000_000;
/** Ripple epoch offset: seconds between Unix epoch (1970) and Ripple epoch (2000-01-01) */
const RIPPLE_EPOCH_OFFSET = 946684800;

/** Convert drops (string) to XRP decimal string */
function dropsToXrp(drops: string): string {
	return new Decimal(drops).div(DROPS_PER_XRP).toFixed();
}

/** Parse an Amount field — string means drops (XRP), object means issued currency */
function parseAmount(amount: string | XrpIssuedAmount): { currency: string; value: string } {
	if (typeof amount === "string") {
		return { currency: "XRP", value: dropsToXrp(amount) };
	}
	return { currency: amount.currency, value: amount.value };
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncXrpAccount(
	backend: Backend,
	account: XrpAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<XrpSyncResult> {
	const result: XrpSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions, marker: newMarker } = await fetchTransactions(
		account.address, account.last_marker ?? undefined, signal,
	);

	if (transactions.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${transactions.length} transactions.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("xrp:")) existingSources.add(e.source);
	}

	// Helpers
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: 6, is_base: false });
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
	const addr = account.address;

	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const { tx, validated } = transactions[i];
		if (!validated) { result.transactions_skipped++; continue; }

		const source = `xrp:${tx.hash}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (tx.meta.TransactionResult !== "tesSUCCESS") {
			result.transactions_skipped++;
			continue;
		}

		// Skip non-Payment types for v1
		if (tx.TransactionType !== "Payment") {
			result.transactions_skipped++;
			continue;
		}

		const date = new Date((tx.date + RIPPLE_EPOCH_OFFSET) * 1000).toISOString().slice(0, 10);

		// Determine delivered amount (prefer delivered_amount from meta for partial payments)
		const rawAmount = tx.meta.delivered_amount ?? tx.Amount;
		if (!rawAmount) {
			result.transactions_skipped++;
			continue;
		}

		const { currency, value } = parseAmount(rawAmount);
		const amount = new Decimal(value);
		if (amount.isZero()) { result.transactions_skipped++; continue; }

		const fee = dropsToXrp(tx.Fee);

		await ensureCurrency(currency);
		if (currency !== "XRP") await ensureCurrency("XRP");

		const isSender = tx.Account === addr;
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (isSender) {
			// Outgoing payment: debit external, credit our wallet
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency, amount: amount.neg().toFixed() },
				{ account: walletExternal(CHAIN, accountPathAddr(tx.Destination ?? "unknown")), currency, amount: amount.toFixed() },
			);
			// Fee (always XRP, always paid by sender)
			lineItemData.push(
				{ account: chainFees(CHAIN), currency: "XRP", amount: fee },
				{ account: walletAssets(CHAIN, account.label), currency: "XRP", amount: new Decimal(fee).neg().toFixed() },
			);
		} else {
			// Incoming payment: debit our wallet, credit external
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency, amount: amount.toFixed() },
				{ account: walletExternal(CHAIN, accountPathAddr(tx.Account)), currency, amount: amount.neg().toFixed() },
			);
		}

		const direction = isSender ? "sent" as const : "received" as const;
		const descData = onchainTransferDescription(CHAIN, currency, direction, { txHash: tx.hash });
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

	// 4. Update marker
	if (newMarker) {
		await backend.updateXrpSyncMarker(account.id, newMarker);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
