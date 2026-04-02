// BTC-fork sync — fetch transactions and create journal entries.
// Parameterized by BtcForkChainConfig to support DOGE, LTC, and BCH.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { BtcForkAccount, BtcForkChainConfig, BtcForkSyncResult, NormalizedTx } from "./types.js";

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

/** Convert satoshis to a decimal coin amount string (e.g., 100000000 → "1.00000000"). */
function satsToCoins(sats: number, decimals: number): string {
	return new Decimal(sats).div(new Decimal(10).pow(decimals)).toFixed(decimals);
}

export async function syncBtcForkAccount(
	backend: Backend,
	account: BtcForkAccount,
	config: BtcForkChainConfig,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<BtcForkSyncResult> {
	const result: BtcForkSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	let txs: NormalizedTx[];
	try {
		txs = await fetchTransactions(config, account.address, signal);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		result.warnings.push(`fetch: ${msg}`);
		return result;
	}

	if (txs.length === 0) {
		onProgress?.("No transactions found.");
		return result;
	}

	// Sort by timestamp ascending
	txs.sort((a, b) => a.timestamp - b.timestamp);
	onProgress?.(`Found ${txs.length} transactions.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);

	const sourcePrefix = `${config.id}:`;
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith(sourcePrefix)) existingSources.add(e.source);
	}

	// Helpers (same pattern as Sui/Aptos sync)
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: config.decimals, is_base: false });
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

	// Ensure chain currency exists
	await ensureCurrency(config.symbol);

	// 3. Process each transaction
	const addr = account.address.toLowerCase();

	for (let i = 0; i < txs.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const tx = txs[i];
		const source = `${config.id}:${tx.txid}`;

		onProgress?.(`Processing ${i + 1}/${txs.length}...`);

		// Store raw transaction
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		// Dedup
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		const date = new Date(tx.timestamp * 1000).toISOString().slice(0, 10);

		// Determine direction: is our address in inputs, outputs, or both?
		const inInputs = tx.inputs.some((inp) => inp.address.toLowerCase() === addr);
		const inOutputs = tx.outputs.some((out) => out.address.toLowerCase() === addr);

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (inInputs && inOutputs && !tx.outputs.some((out) => out.address.toLowerCase() !== addr)) {
			// Self-transfer (all outputs to self) — only record fee
			if (tx.fee > 0) {
				const feeCoins = satsToCoins(tx.fee, config.decimals);
				lineItemData.push(
					{ account: chainFees(config.name), currency: config.symbol, amount: feeCoins },
					{ account: walletAssets(config.name, account.label), currency: config.symbol, amount: new Decimal(feeCoins).neg().toFixed() },
				);
			}
		} else if (inInputs) {
			// Sent: sum outputs NOT to our address = amount sent
			const sentSats = tx.outputs
				.filter((out) => out.address.toLowerCase() !== addr)
				.reduce((sum, out) => sum + out.value, 0);
			const sentCoins = satsToCoins(sentSats, config.decimals);

			// Determine primary external recipient for description
			const externalOutputs = tx.outputs.filter((out) => out.address.toLowerCase() !== addr);
			const primaryRecipient = externalOutputs.length > 0 ? externalOutputs[0].address : "";

			lineItemData.push(
				{ account: walletAssets(config.name, account.label), currency: config.symbol, amount: new Decimal(sentCoins).neg().toFixed() },
				{ account: walletExternal(config.name, accountPathAddr(primaryRecipient)), currency: config.symbol, amount: sentCoins },
			);

			// Fee
			if (tx.fee > 0) {
				const feeCoins = satsToCoins(tx.fee, config.decimals);
				lineItemData.push(
					{ account: chainFees(config.name), currency: config.symbol, amount: feeCoins },
					{ account: walletAssets(config.name, account.label), currency: config.symbol, amount: new Decimal(feeCoins).neg().toFixed() },
				);
			}
		} else if (inOutputs) {
			// Received: sum outputs TO our address
			const receivedSats = tx.outputs
				.filter((out) => out.address.toLowerCase() === addr)
				.reduce((sum, out) => sum + out.value, 0);
			const receivedCoins = satsToCoins(receivedSats, config.decimals);

			const senderAddr = tx.inputs.length > 0 ? tx.inputs[0].address : "";

			lineItemData.push(
				{ account: walletAssets(config.name, account.label), currency: config.symbol, amount: receivedCoins },
				{ account: walletExternal(config.name, accountPathAddr(senderAddr)), currency: config.symbol, amount: new Decimal(receivedCoins).neg().toFixed() },
			);
		} else {
			// Address not in inputs or outputs — skip
			result.transactions_skipped++;
			continue;
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		// Determine direction for description
		const direction: "sent" | "received" | "self" = inInputs && inOutputs && !tx.outputs.some((out) => out.address.toLowerCase() !== addr)
			? "self"
			: inInputs ? "sent" : "received";

		const descData = onchainTransferDescription(config.name, config.symbol, direction, { txHash: tx.txid });
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
			result.warnings.push(`post ${config.id}:${tx.txid.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
