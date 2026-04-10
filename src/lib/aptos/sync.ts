// Aptos sync — fetch activities via Indexer GraphQL and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { ensureCurrencyExists } from "../currency-type.js";
import { fetchActivities } from "./api.js";
import type { GenericBlockchainAccount } from "../backend.js";
import type { AptosSyncResult, AptosActivity } from "./types.js";

const CHAIN = "Aptos";

/** Extract short symbol from Aptos asset type (e.g., "0x1::aptos_coin::AptosCoin" → "APT") */
function coinSymbol(assetType: string): string {
	const parts = assetType.split("::");
	const raw = parts[parts.length - 1] ?? assetType;
	if (raw === "AptosCoin") return "APT";
	return raw;
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncAptosAccount(
	backend: Backend,
	account: GenericBlockchainAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<AptosSyncResult> {
	const result: AptosSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch activities
	onProgress?.("Fetching activities...");
	const activities = await fetchActivities(account.address, account.cursor ? parseInt(account.cursor) : undefined, signal);

	if (activities.length === 0) {
		onProgress?.("No new activities found.");
		return result;
	}

	onProgress?.(`Found ${activities.length} activities.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("aptos:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string): Promise<void> {
		await ensureCurrencyExists(backend, code, currencySet, { context: "crypto-chain", decimals: 8 });
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

	// 3. Group activities by transaction_version
	const byVersion = new Map<number, AptosActivity[]>();
	for (const act of activities) {
		const group = byVersion.get(act.transaction_version) ?? [];
		group.push(act);
		byVersion.set(act.transaction_version, group);
	}

	let maxVersion = account.cursor ? parseInt(account.cursor) : 0;

	for (const [version, group] of byVersion) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const source = `aptos:${version}`;
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			if (version > maxVersion) maxVersion = version;
			continue;
		}

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(group)); } catch { /* may exist */ }

		const first = group[0];
		const date = first.transaction_timestamp
			? new Date(first.transaction_timestamp).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		// Build line items from activities
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let mainSymbol = "APT";
		let netDirection: "sent" | "received" | "self" = "self";

		for (const act of group) {
			if (!act.amount) continue;
			const symbol = coinSymbol(act.asset_type);
			mainSymbol = symbol;
			const amount = new Decimal(act.amount);

			await ensureCurrency(symbol);

			// Determine sign: deposit types are positive, withdraw types are negative
			const isDeposit = act.type.includes("Deposit") || act.type.includes("deposit");
			const isGas = act.is_gas_fee;
			const signedAmount = isDeposit ? amount : amount.neg();

			if (isGas) {
				// Gas fee
				lineItemData.push(
					{ account: chainFees(CHAIN), currency: symbol, amount: amount.toFixed() },
					{ account: walletAssets(CHAIN, account.label), currency: symbol, amount: amount.neg().toFixed() },
				);
			} else {
				lineItemData.push(
					{ account: walletAssets(CHAIN, account.label), currency: symbol, amount: signedAmount.toFixed() },
					{ account: walletExternal(CHAIN, accountPathAddr(account.address)), currency: symbol, amount: signedAmount.neg().toFixed() },
				);

				if (signedAmount.gt(0)) netDirection = "received";
				else if (signedAmount.lt(0)) netDirection = "sent";
			}
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			if (version > maxVersion) maxVersion = version;
			continue;
		}

		const descData = onchainTransferDescription(CHAIN, mainSymbol, netDirection, { txHash: String(version) });
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
			"aptos:version": String(version),
			"aptos:direction": netDirection,
			"aptos:asset": mainSymbol,
		};
		const actTypes = group.map((a) => a.type).join(",");
		if (actTypes) meta["aptos:activity_types"] = actTypes;
		const gasAct = group.find((a) => a.is_gas_fee);
		if (gasAct?.amount) meta["aptos:gas_fee"] = String(gasAct.amount);

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post aptos:${version}: ${e instanceof Error ? e.message : String(e)}`);
		}

		if (version > maxVersion) maxVersion = version;
	}

	// 4. Update version cursor
	if (maxVersion > (account.cursor ? parseInt(account.cursor) : 0)) {
		await backend.updateBlockchainAccountCursor(account.id, String(maxVersion));
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
