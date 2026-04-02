// Tezos sync — fetch operations and token transfers via TzKT and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchOperations, fetchTokenTransfers } from "./api.js";
import type { TezosAccount, TezosSyncResult, TezosOperation, TezosTokenTransfer } from "./types.js";

const CHAIN = "Tezos";
const MUTEZ_DIVISOR = new Decimal("1000000"); // 10^6

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncTezosAccount(
	backend: Backend,
	account: TezosAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<TezosSyncResult> {
	const result: TezosSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch operations and token transfers
	onProgress?.("Fetching XTZ operations...");
	const operations = await fetchOperations(account.address, account.last_id ?? undefined, signal);

	onProgress?.("Fetching token transfers...");
	const tokenTransfers = await fetchTokenTransfers(account.address, account.last_id ?? undefined, signal);

	if (operations.length === 0 && tokenTransfers.length === 0) {
		onProgress?.("No new activity found.");
		return result;
	}

	onProgress?.(`Found ${operations.length} operations and ${tokenTransfers.length} token transfers.`);

	// 2. Build caches
	const newCurrencies: string[] = [];
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("tezos:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string, decimals: number): Promise<void> {
		if (currencySet.has(code)) return;
		await backend.createCurrency({ code, asset_type: "", param: "", name: code, decimal_places: decimals, is_base: false });
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

	// 3. Process XTZ operations
	let maxId = account.last_id ?? 0;

	for (const op of operations) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const source = `tezos:op:${op.id}`;
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			if (op.id > maxId) maxId = op.id;
			continue;
		}

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(op)); } catch { /* may exist */ }

		const date = op.timestamp
			? new Date(op.timestamp).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		await ensureCurrency("XTZ", 6);

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let direction: "sent" | "received" | "self" = "self";

		const isSender = op.sender.address === account.address;
		const isTarget = op.target?.address === account.address;

		if (isSender && isTarget) {
			direction = "self";
		} else if (isSender) {
			direction = "sent";
		} else if (isTarget) {
			direction = "received";
		}

		// XTZ amount
		const xtzAmount = new Decimal(op.amount).div(MUTEZ_DIVISOR);
		if (!xtzAmount.isZero()) {
			const signedAmount = direction === "received" ? xtzAmount : xtzAmount.neg();
			const counterparty = direction === "sent"
				? shortAddr(op.target?.address ?? "unknown")
				: shortAddr(op.sender.address);

			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "XTZ", amount: signedAmount.toFixed() },
				{ account: walletExternal(CHAIN, counterparty), currency: "XTZ", amount: signedAmount.neg().toFixed() },
			);
		}

		// Gas fees (only paid by sender)
		if (isSender) {
			const gasFee = new Decimal(op.bakerFee + op.storageFee).div(MUTEZ_DIVISOR);
			if (!gasFee.isZero()) {
				lineItemData.push(
					{ account: chainFees(CHAIN), currency: "XTZ", amount: gasFee.toFixed() },
					{ account: walletAssets(CHAIN, account.label), currency: "XTZ", amount: gasFee.neg().toFixed() },
				);
			}
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			if (op.id > maxId) maxId = op.id;
			continue;
		}

		const descData = onchainTransferDescription(CHAIN, "XTZ", direction, { txHash: op.hash });
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
			result.warnings.push(`post tezos:op:${op.id}: ${e instanceof Error ? e.message : String(e)}`);
		}

		if (op.id > maxId) maxId = op.id;
	}

	// 4. Process token transfers
	for (const tt of tokenTransfers) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const source = `tezos:token:${tt.id}`;
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			if (tt.id > maxId) maxId = tt.id;
			continue;
		}

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tt)); } catch { /* may exist */ }

		const date = tt.timestamp
			? new Date(tt.timestamp).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		// Parse token metadata
		const symbol = tt.token.metadata?.symbol ?? tt.token.contract.address;
		const decimals = tt.token.metadata?.decimals ? parseInt(tt.token.metadata.decimals, 10) : 0;

		await ensureCurrency(symbol, decimals);

		const isSender = tt.from?.address === account.address;
		const isReceiver = tt.to?.address === account.address;

		let direction: "sent" | "received" | "self" = "self";
		if (isSender && isReceiver) {
			direction = "self";
		} else if (isSender) {
			direction = "sent";
		} else if (isReceiver) {
			direction = "received";
		}

		const rawAmount = new Decimal(tt.amount);
		const tokenAmount = decimals > 0 ? rawAmount.div(new Decimal(10).pow(decimals)) : rawAmount;
		const signedAmount = direction === "received" ? tokenAmount : tokenAmount.neg();

		const counterparty = direction === "sent"
			? shortAddr(tt.to?.address ?? "unknown")
			: shortAddr(tt.from?.address ?? "unknown");

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [
			{ account: walletAssets(CHAIN, account.label), currency: symbol, amount: signedAmount.toFixed() },
			{ account: walletExternal(CHAIN, counterparty), currency: symbol, amount: signedAmount.neg().toFixed() },
		];

		const descData = onchainTransferDescription(CHAIN, symbol, direction, { txHash: String(tt.transactionId ?? tt.id) });
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
			result.warnings.push(`post tezos:token:${tt.id}: ${e instanceof Error ? e.message : String(e)}`);
		}

		if (tt.id > maxId) maxId = tt.id;
	}

	// 5. Update cursor
	if (maxId > (account.last_id ?? 0)) {
		await backend.updateTezosSyncCursor(account.id, maxId);
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
