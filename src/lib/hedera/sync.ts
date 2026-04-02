// Hedera sync — fetch transactions via Mirror Node and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { HederaAccount, HederaSyncResult, HederaTransaction } from "./types.js";

const CHAIN = "Hedera";
const HBAR_DECIMALS = 8; // 1 HBAR = 10^8 tinybar

function tinybarToHbar(tinybar: number): string {
	return new Decimal(tinybar).div(new Decimal(10).pow(HBAR_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncHederaAccount(
	backend: Backend,
	account: HederaAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<HederaSyncResult> {
	const result: HederaSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions, cursor } = await fetchTransactions(account.address, account.last_timestamp ?? undefined, signal);

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
		if (e.source.startsWith("hedera:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string, decimals?: number): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: decimals ?? HBAR_DECIMALS, is_base: false });
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

	await ensureCurrency("HBAR");

	// 3. Process transactions
	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = transactions[i];
		const source = `hedera:${tx.transaction_id}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (tx.result !== "SUCCESS") {
			result.transactions_skipped++;
			continue;
		}

		if (tx.name !== "CRYPTOTRANSFER") {
			result.transactions_skipped++;
			continue;
		}

		// Parse consensus timestamp to date
		const timestampSeconds = parseFloat(tx.consensus_timestamp);
		const date = new Date(timestampSeconds * 1000).toISOString().slice(0, 10);

		// Find our net HBAR change from transfers
		const myTransfers = tx.transfers.filter(t => t.account === account.address);
		const netAmount = myTransfers.reduce((sum, t) => sum + t.amount, 0);

		if (netAmount === 0) {
			result.transactions_skipped++;
			continue;
		}

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		const hbarAmount = tinybarToHbar(Math.abs(netAmount));
		const direction: "sent" | "received" | "self" = netAmount > 0 ? "received" : "sent";

		// Find counterparty (the other party with largest opposite transfer)
		const otherTransfers = tx.transfers.filter(t => t.account !== account.address);
		const counterparty = otherTransfers.length > 0
			? otherTransfers.reduce((a, b) => Math.abs(b.amount) > Math.abs(a.amount) ? b : a).account
			: "unknown";

		if (direction === "received") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "HBAR", amount: hbarAmount },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "HBAR", amount: new Decimal(hbarAmount).neg().toFixed() },
			);
		} else {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "HBAR", amount: new Decimal(hbarAmount).neg().toFixed() },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "HBAR", amount: hbarAmount },
			);
		}

		// Fee
		const fee = tinybarToHbar(tx.charged_tx_fee);
		if (new Decimal(fee).gt(0)) {
			lineItemData.push(
				{ account: chainFees(CHAIN), currency: "HBAR", amount: fee },
				{ account: walletAssets(CHAIN, account.label), currency: "HBAR", amount: new Decimal(fee).neg().toFixed() },
			);
		}

		const descData = onchainTransferDescription(CHAIN, "HBAR", direction, { txHash: tx.transaction_id });
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
			result.warnings.push(`post ${tx.transaction_id}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	if (cursor) {
		await backend.updateHederaSyncCursor(account.id, cursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
