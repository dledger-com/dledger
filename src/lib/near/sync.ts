// NEAR sync — fetch transactions via NEAR Blocks and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { NearAccount, NearSyncResult, NearTransaction } from "./types.js";

const CHAIN = "NEAR";
const NEAR_DECIMALS = 24; // 1 NEAR = 10^24 yoctoNEAR

function yoctoToNear(yocto: string): string {
	return new Decimal(yocto).div(new Decimal(10).pow(NEAR_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	if (addr.endsWith(".near")) return addr;
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	if (addr.endsWith(".near")) return addr;
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncNearAccount(
	backend: Backend,
	account: NearAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<NearSyncResult> {
	const result: NearSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { txns, cursor } = await fetchTransactions(account.address, account.last_cursor ?? undefined, signal);

	if (txns.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${txns.length} transactions.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("near:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string, decimals?: number): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: decimals ?? NEAR_DECIMALS, is_base: false });
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

	await ensureCurrency("NEAR");

	// 3. Process transactions
	for (let i = 0; i < txns.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = txns[i];
		const source = `near:${tx.transaction_hash}`;

		onProgress?.(`Processing ${i + 1}/${txns.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (!tx.outcomes.status) {
			result.transactions_skipped++;
			continue;
		}

		// Parse nanosecond timestamp
		const timestampNs = BigInt(tx.block_timestamp);
		const date = new Date(Number(timestampNs / 1_000_000n)).toISOString().slice(0, 10);

		// Process TRANSFER actions
		const transferActions = tx.actions.filter(a => a.action === "TRANSFER" && a.deposit);
		if (transferActions.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		for (const action of transferActions) {
			const deposit = action.deposit!;
			const amount = yoctoToNear(deposit);

			if (new Decimal(amount).isZero()) continue;

			const isSender = tx.signer_account_id === account.address;
			const isReceiver = tx.receiver_account_id === account.address;
			const direction: "sent" | "received" | "self" = isSender && isReceiver ? "self" : isSender ? "sent" : "received";
			const counterparty = isSender ? tx.receiver_account_id : tx.signer_account_id;

			const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

			if (direction === "sent") {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "NEAR", amount: new Decimal(amount).neg().toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "NEAR", amount: amount },
				);
			} else if (direction === "received") {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "NEAR", amount: amount },
					{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "NEAR", amount: new Decimal(amount).neg().toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "NEAR", amount: "0" },
					{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "NEAR", amount: "0" },
				);
			}

			const descData = onchainTransferDescription(CHAIN, "NEAR", direction, { txHash: tx.transaction_hash });
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
				"near:hash": tx.transaction_hash,
				"near:direction": direction,
				"near:amount": amount,
				"near:counterparty": counterparty,
				"near:block_timestamp": tx.block_timestamp,
				"near:signer": tx.signer_account_id,
				"near:receiver": tx.receiver_account_id,
			};

			try {
				await backend.postJournalEntry(entry, lineItems);
				await backend.setMetadata(entryId, meta);
				existingSources.add(source);
				result.transactions_imported++;
			} catch (e) {
				result.warnings.push(`post ${tx.transaction_hash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	// 4. Update cursor
	if (cursor) {
		await backend.updateNearSyncCursor(account.id, cursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
