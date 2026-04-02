// TRON sync — fetch transactions via TronGrid and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { TronAccount, TronSyncResult, TronTransaction, TronTransferValue } from "./types.js";

const CHAIN = "Tron";
const SUN_PER_TRX = 1_000_000;

/** Convert SUN (number) to TRX decimal string */
function sunToTrx(sun: number): string {
	return new Decimal(sun).div(SUN_PER_TRX).toFixed();
}

/** Convert hex-encoded TRON address to Base58Check T-address for display */
function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

/** Decode TRC-20 transfer from ABI-encoded call data (transfer(address,uint256)) */
function decodeTrc20Transfer(data: string): { to: string; amount: string } | null {
	// transfer(address,uint256) selector: a9059cbb
	if (!data.startsWith("a9059cbb") || data.length < 136) return null;
	// address is in bytes 4..36 (padded to 32 bytes), amount is in bytes 36..68
	const toHex = data.slice(8, 72); // 32 bytes, address padded
	const amountHex = data.slice(72, 136); // 32 bytes
	const to = "41" + toHex.slice(24); // TRON addresses use 0x41 prefix
	const amount = new Decimal("0x" + amountHex).toFixed();
	return { to, amount };
}

export async function syncTronAccount(
	backend: Backend,
	account: TronAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<TronSyncResult> {
	const result: TronSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { transactions, fingerprint: newFingerprint } = await fetchTransactions(
		account.address, account.last_fingerprint ?? undefined, signal,
	);

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
		if (e.source.startsWith("tron:")) existingSources.add(e.source);
	}

	// Helpers
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		await backend.createCurrency({ code, asset_type: "", param: "", name: code, decimal_places: 6, is_base: false });
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

	// 3. Process transactions
	const addr = account.address;

	for (let i = 0; i < transactions.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = transactions[i];
		const source = `tron:${tx.txID}`;

		onProgress?.(`Processing ${i + 1}/${transactions.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		// Check success
		if (!tx.ret?.[0] || tx.ret[0].contractRet !== "SUCCESS") {
			result.transactions_skipped++;
			continue;
		}

		const contract = tx.raw_data.contract[0];
		if (!contract) { result.transactions_skipped++; continue; }

		const date = new Date(tx.block_timestamp).toISOString().slice(0, 10);
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let mainCurrency = "TRX";
		let direction: "sent" | "received" | "self" = "self";

		if (contract.type === "TransferContract") {
			// Native TRX transfer
			const value = contract.parameter.value as TronTransferValue;
			const amount = sunToTrx(value.amount);
			const decAmount = new Decimal(amount);
			if (decAmount.isZero()) { result.transactions_skipped++; continue; }

			await ensureCurrency("TRX");
			mainCurrency = "TRX";

			const isSender = value.owner_address === addr;
			direction = isSender ? "sent" : "received";

			if (isSender) {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "TRX", amount: decAmount.neg().toFixed() },
					{ account: walletExternal(CHAIN, shortAddr(value.to_address)), currency: "TRX", amount: decAmount.toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: "TRX", amount: decAmount.toFixed() },
					{ account: walletExternal(CHAIN, shortAddr(value.owner_address)), currency: "TRX", amount: decAmount.neg().toFixed() },
				);
			}
		} else if (contract.type === "TriggerSmartContract") {
			// TRC-20 token transfer
			const value = contract.parameter.value as { owner_address: string; contract_address: string; data?: string };
			if (!value.data) { result.transactions_skipped++; continue; }

			const transfer = decodeTrc20Transfer(value.data);
			if (!transfer) { result.transactions_skipped++; continue; }

			// For TRC-20, we use a generic token symbol since we only have the contract address
			// A more complete implementation would look up the token contract
			const tokenSymbol = "TRC20";
			await ensureCurrency(tokenSymbol);
			mainCurrency = tokenSymbol;

			const isSender = value.owner_address === addr;
			direction = isSender ? "sent" : "received";
			const decAmount = new Decimal(transfer.amount);

			if (isSender) {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: tokenSymbol, amount: decAmount.neg().toFixed() },
					{ account: walletExternal(CHAIN, shortAddr(transfer.to)), currency: tokenSymbol, amount: decAmount.toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: tokenSymbol, amount: decAmount.toFixed() },
					{ account: walletExternal(CHAIN, shortAddr(value.owner_address)), currency: tokenSymbol, amount: decAmount.neg().toFixed() },
				);
			}
		} else {
			// Skip other transaction types for v1
			result.transactions_skipped++;
			continue;
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		const descData = onchainTransferDescription(CHAIN, mainCurrency, direction, { txHash: tx.txID });
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
			result.warnings.push(`post ${tx.txID.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update fingerprint cursor
	if (newFingerprint) {
		await backend.updateTronSyncFingerprint(account.id, newFingerprint);
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
