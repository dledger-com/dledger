// Monero sync — fetch incoming transactions via Light Wallet Server (LWS) and create journal entries.
// Note: view key only reveals INCOMING transactions. Outgoing transfers are not visible.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { lwsLogin, fetchAddressTransactions } from "./api.js";
import type { MoneroAccount, MoneroSyncResult, LwsTransaction } from "./types.js";

const CHAIN = "Monero";
const XMR_DECIMALS = 12; // 1 XMR = 10^12 piconero

function piconeroToXmr(piconero: string): string {
	return new Decimal(piconero).div(new Decimal(10).pow(XMR_DECIMALS)).toFixed();
}

export async function syncMoneroAccount(
	backend: Backend,
	account: MoneroAccount,
	settings: AppSettings,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<MoneroSyncResult> {
	const lwsUrl = settings.moneroLwsUrl;
	if (!lwsUrl) {
		throw new Error("Monero LWS URL is required. Configure it in Settings → API Keys.");
	}

	const result: MoneroSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Login to LWS (registers address if first time)
	onProgress?.("Registering with Light Wallet Server...");
	try {
		await lwsLogin(lwsUrl, account.address, account.view_key, signal);
	} catch (e) {
		throw new Error(`LWS login failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 2. Fetch transactions
	onProgress?.("Fetching transactions...");
	const response = await fetchAddressTransactions(lwsUrl, account.address, account.view_key, signal);

	// Filter to new transactions only (above last sync height, confirmed)
	const minHeight = account.last_sync_height ?? 0;
	const newTxs = response.transactions.filter(
		(tx: LwsTransaction) => tx.height > minHeight && !tx.mempool,
	);

	if (newTxs.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${newTxs.length} new transactions.`);

	// 3. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("monero:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string, decimals?: number): Promise<void> {
		if (currencySet.has(code)) return;
		await backend.createCurrency({ code, asset_type: "", param: "", name: code, decimal_places: decimals ?? XMR_DECIMALS, is_base: false });
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

	await ensureCurrency("XMR");

	// 4. Process transactions
	let maxHeight = minHeight;

	for (let i = 0; i < newTxs.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = newTxs[i];
		const source = `monero:${tx.hash}`;

		onProgress?.(`Processing ${i + 1}/${newTxs.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			if (tx.height > maxHeight) maxHeight = tx.height;
			continue;
		}

		// Parse timestamp
		const date = tx.timestamp
			? new Date(typeof tx.timestamp === "string" && /^\d+$/.test(tx.timestamp)
				? parseInt(tx.timestamp) * 1000
				: tx.timestamp,
			).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		// Compute net amount received (total_received - total_sent in piconero)
		const received = new Decimal(tx.total_received || "0");
		const sent = new Decimal(tx.total_sent || "0");
		const netReceived = received.minus(sent);

		if (netReceived.isZero() || netReceived.lt(0)) {
			// View key can't reliably show outgoing — skip
			result.transactions_skipped++;
			if (tx.height > maxHeight) maxHeight = tx.height;
			continue;
		}

		const amount = piconeroToXmr(netReceived.toFixed());
		const direction: "sent" | "received" | "self" = "received";

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [
			{ account: walletAssets(CHAIN, account.label), currency: "XMR", amount },
			{ account: walletExternal(CHAIN, "unknown"), currency: "XMR", amount: new Decimal(amount).neg().toFixed() },
		];

		const descData = onchainTransferDescription(CHAIN, "XMR", direction, { txHash: tx.hash });
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

		if (tx.height > maxHeight) maxHeight = tx.height;
	}

	// 5. Update height cursor
	if (maxHeight > minHeight) {
		await backend.updateMoneroSyncHeight(account.id, maxHeight);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");
	return result;
}
