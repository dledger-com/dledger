// Cardano sync — fetch transactions via Blockfrost and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchAddressTransactions, fetchTxUtxos, fetchTxInfo } from "./api.js";
import type { CardanoAccount, CardanoSyncResult, BlockfrostAddressTx } from "./types.js";

const CHAIN = "Cardano";
const ADA_DECIMALS = 6; // 1 ADA = 10^6 lovelace

function lovelaceToAda(lovelace: string): string {
	return new Decimal(lovelace).div(new Decimal(10).pow(ADA_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 10)}-${addr.slice(-4)}` : addr;
}

export async function syncCardanoAccount(
	backend: Backend,
	account: CardanoAccount,
	settings: AppSettings,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<CardanoSyncResult> {
	const apiKey = settings.blockfrostApiKey;
	if (!apiKey) {
		throw new Error("Blockfrost API key is required for Cardano sync. Set it in Settings → API Keys.");
	}

	const result: CardanoSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions, nextPage } = await fetchAddressTransactions(
		account.address, apiKey, account.last_page ?? undefined, signal,
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
		if (e.source.startsWith("cardano:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string, decimals?: number): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: decimals ?? ADA_DECIMALS, is_base: false });
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

	await ensureCurrency("ADA");

	// 3. Process transactions
	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx: BlockfrostAddressTx = transactions[i];
		const source = `cardano:${tx.tx_hash}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		const date = new Date(tx.block_time * 1000).toISOString().slice(0, 10);

		// Fetch UTXO details and tx info for fees
		let utxos, txInfo;
		try {
			[utxos, txInfo] = await Promise.all([
				fetchTxUtxos(tx.tx_hash, apiKey, signal),
				fetchTxInfo(tx.tx_hash, apiKey, signal),
			]);
		} catch (e) {
			result.warnings.push(`fetch utxos ${tx.tx_hash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
			result.transactions_skipped++;
			continue;
		}

		// Determine if our address is in inputs/outputs
		const addr = account.address;
		const isInInput = utxos.inputs.some(inp => inp.address === addr);
		const isInOutput = utxos.outputs.some(out => out.address === addr);

		// Sum ADA (unit "lovelace") going to/from our address
		let totalIn = new Decimal(0); // lovelace received in outputs
		let totalOut = new Decimal(0); // lovelace spent from inputs

		for (const inp of utxos.inputs) {
			if (inp.address === addr) {
				const lovelace = inp.amount.find(a => a.unit === "lovelace");
				if (lovelace) totalOut = totalOut.plus(lovelace.quantity);
			}
		}
		for (const out of utxos.outputs) {
			if (out.address === addr) {
				const lovelace = out.amount.find(a => a.unit === "lovelace");
				if (lovelace) totalIn = totalIn.plus(lovelace.quantity);
			}
		}

		const fee = new Decimal(txInfo.fees);
		const netChange = totalIn.minus(totalOut); // positive = received, negative = sent

		if (netChange.isZero() && !isInInput) {
			result.transactions_skipped++;
			continue;
		}

		const direction: "sent" | "received" | "self" =
			isInInput && isInOutput && netChange.plus(fee).isZero() ? "self" :
			netChange.lt(0) ? "sent" : "received";

		// Find a counterparty address
		let counterparty: string | undefined;
		if (direction === "sent") {
			const otherOutputs = utxos.outputs.filter(o => o.address !== addr);
			counterparty = otherOutputs[0]?.address;
		} else if (direction === "received") {
			const otherInputs = utxos.inputs.filter(i => i.address !== addr);
			counterparty = otherInputs[0]?.address;
		}

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		const absNet = netChange.abs();

		if (direction === "sent") {
			// We sent: our wallet decreases, counterparty increases
			const sentAmount = absNet.minus(fee); // net amount sent (excluding fee)
			if (sentAmount.gt(0) && counterparty) {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "ADA", amount: lovelaceToAda(sentAmount.neg().toFixed()) },
					{ account: walletExternal(CHAIN, shortAddr(counterparty)), currency: "ADA", amount: lovelaceToAda(sentAmount.toFixed()) },
				);
			}
			if (fee.gt(0)) {
				lineItemData.push(
					{ account: chainFees(CHAIN), currency: "ADA", amount: lovelaceToAda(fee.toFixed()) },
					{ account: walletAssets(CHAIN, account.label), currency: "ADA", amount: lovelaceToAda(fee.neg().toFixed()) },
				);
			}
		} else if (direction === "received") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "ADA", amount: lovelaceToAda(netChange.toFixed()) },
				{ account: walletExternal(CHAIN, shortAddr(counterparty ?? "unknown")), currency: "ADA", amount: lovelaceToAda(netChange.neg().toFixed()) },
			);
		} else {
			// Self-transfer: only fee matters
			if (fee.gt(0)) {
				lineItemData.push(
					{ account: chainFees(CHAIN), currency: "ADA", amount: lovelaceToAda(fee.toFixed()) },
					{ account: walletAssets(CHAIN, account.label), currency: "ADA", amount: lovelaceToAda(fee.neg().toFixed()) },
				);
			}
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		const descData = onchainTransferDescription(CHAIN, "ADA", direction, { txHash: tx.tx_hash });
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
			result.warnings.push(`post ${tx.tx_hash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update page cursor
	if (nextPage !== null) {
		await backend.updateCardanoSyncPage(account.id, nextPage);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
