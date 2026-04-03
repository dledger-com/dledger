// Kaspa sync — fetch UTXO transactions via Kaspa REST API and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { KaspaAccount, KaspaSyncResult, KaspaTransaction } from "./types.js";

const CHAIN = "Kaspa";
const KAS_DECIMALS = 8; // 1 KAS = 10^8 sompi

function sompiToKas(sompi: number): string {
	return new Decimal(sompi).div(new Decimal(10).pow(KAS_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	// kaspa: prefix + bech32 — show prefix + first few + last few
	if (addr.startsWith("kaspa:")) {
		const body = addr.slice(6);
		return body.length > 12 ? `kaspa:${body.slice(0, 6)}…${body.slice(-4)}` : addr;
	}
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	if (addr.startsWith("kaspa:")) {
		const body = addr.slice(6);
		return body.length > 12 ? `kaspa:${body.slice(0, 6)}-${body.slice(-4)}` : addr;
	}
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncKaspaAccount(
	backend: Backend,
	account: KaspaAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<KaspaSyncResult> {
	const result: KaspaSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions, cursor } = await fetchTransactions(account.address, account.last_cursor ?? undefined, signal);

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
		if (e.source.startsWith("kaspa:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: KAS_DECIMALS, is_base: false });
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

	await ensureCurrency("KAS");

	// 3. Process transactions (UTXO model)
	const addr = account.address;

	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = transactions[i];
		const source = `kaspa:${tx.transaction_id}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (!tx.is_accepted) {
			result.transactions_skipped++;
			continue;
		}

		const date = new Date(tx.block_time).toISOString().slice(0, 10);

		// Calculate net balance change from UTXO inputs/outputs
		const inputSum = tx.inputs
			.filter(inp => inp.previous_outpoint_address === addr)
			.reduce((sum, inp) => sum + inp.previous_outpoint_amount, 0);

		const outputSum = tx.outputs
			.filter(out => out.script_public_key_address === addr)
			.reduce((sum, out) => sum + out.amount, 0);

		const netSompi = outputSum - inputSum;
		if (netSompi === 0) {
			result.transactions_skipped++;
			continue;
		}

		const amount = sompiToKas(Math.abs(netSompi));
		const direction: "sent" | "received" = netSompi > 0 ? "received" : "sent";

		// Find counterparty
		let counterparty = "unknown";
		if (direction === "sent") {
			const otherOutput = tx.outputs.find(o => o.script_public_key_address !== addr);
			if (otherOutput) counterparty = otherOutput.script_public_key_address;
		} else {
			const otherInput = tx.inputs.find(inp => inp.previous_outpoint_address !== addr);
			if (otherInput) counterparty = otherInput.previous_outpoint_address;
		}

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (direction === "sent") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "KAS", amount: new Decimal(amount).neg().toFixed() },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "KAS", amount: amount },
			);
		} else {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "KAS", amount: amount },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "KAS", amount: new Decimal(amount).neg().toFixed() },
			);
		}

		// Fee is implicit in UTXO (inputSum - total outputSum)
		if (direction === "sent") {
			const totalOutputSum = tx.outputs.reduce((sum, out) => sum + out.amount, 0);
			const feeSompi = inputSum - totalOutputSum;
			if (feeSompi > 0) {
				const fee = sompiToKas(feeSompi);
				lineItemData.push(
					{ account: chainFees(CHAIN), currency: "KAS", amount: fee },
					{ account: walletAssets(CHAIN, account.label), currency: "KAS", amount: new Decimal(fee).neg().toFixed() },
				);
			}
		}

		const descData = onchainTransferDescription(CHAIN, "KAS", direction, { txHash: tx.transaction_id });
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
			"kaspa:txid": tx.transaction_id,
			"kaspa:direction": direction,
			"kaspa:amount": amount,
			"kaspa:counterparty": counterparty,
			"kaspa:input_count": String(tx.inputs.length),
			"kaspa:output_count": String(tx.outputs.length),
		};

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${tx.transaction_id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	if (cursor) {
		await backend.updateKaspaSyncCursor(account.id, cursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
