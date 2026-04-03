// Bittensor sync — fetch transfers and rewards via Subscan and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription, rewardDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransfers, fetchRewards } from "./api.js";
import type { BittensorAccount, BittensorSyncResult, BittensorTransfer, BittensorReward } from "./types.js";

const CHAIN = "Bittensor";
const TAO_DECIMALS = 9; // 1 TAO = 10^9 rao
const STAKING_INCOME_ACCOUNT = "Income:Crypto:Staking:Bittensor";
const STAKING_EXPENSE_ACCOUNT = "Expenses:Crypto:Staking:Bittensor";

function raoToTao(rao: string): string {
	return new Decimal(rao).div(new Decimal(10).pow(TAO_DECIMALS)).toFixed();
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncBittensorAccount(
	backend: Backend,
	account: BittensorAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<BittensorSyncResult> {
	const result: BittensorSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transfers and rewards
	onProgress?.("Fetching transfers...");
	const transfers = await fetchTransfers(account.address, account.last_page ?? undefined, signal);

	onProgress?.("Fetching rewards...");
	const rewards = await fetchRewards(account.address, undefined, signal);

	if (transfers.length === 0 && rewards.length === 0) {
		onProgress?.("No new activities found.");
		return result;
	}

	onProgress?.(`Found ${transfers.length} transfers and ${rewards.length} rewards.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("bittensor:")) existingSources.add(e.source);
	}

	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: TAO_DECIMALS, is_base: false });
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

	await ensureCurrency("TAO");

	// 3. Process transfers
	let maxPage = account.last_page ?? 0;

	for (const tx of transfers) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		if (!tx.success) {
			result.transactions_skipped++;
			continue;
		}

		const source = `bittensor:xfer:${tx.extrinsic_index}`;
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		const date = new Date(tx.block_timestamp * 1000).toISOString().slice(0, 10);
		const amount = raoToTao(tx.amount);
		const fee = raoToTao(tx.fee);

		const isSender = tx.from.toLowerCase() === account.address.toLowerCase();
		const isReceiver = tx.to.toLowerCase() === account.address.toLowerCase();
		const direction: "sent" | "received" | "self" = isSender && isReceiver ? "self" : isSender ? "sent" : "received";
		const counterparty = isSender ? tx.to : tx.from;

		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (direction === "sent") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: new Decimal(amount).neg().toFixed() },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "TAO", amount: amount },
			);
		} else if (direction === "received") {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: amount },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "TAO", amount: new Decimal(amount).neg().toFixed() },
			);
		} else {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: "0" },
				{ account: walletExternal(CHAIN, accountPathAddr(counterparty)), currency: "TAO", amount: "0" },
			);
		}

		// Fee (charged to sender)
		if (isSender && new Decimal(fee).gt(0)) {
			lineItemData.push(
				{ account: chainFees(CHAIN), currency: "TAO", amount: fee },
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: new Decimal(fee).neg().toFixed() },
			);
		}

		const descData = onchainTransferDescription(CHAIN, "TAO", direction, { txHash: tx.hash });
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
			"tao:extrinsic_index": tx.extrinsic_index,
			"tao:hash": tx.hash,
			"tao:direction": direction,
			"tao:amount": amount,
			"tao:counterparty": counterparty,
			"tao:fee": fee,
			"tao:block_timestamp": String(tx.block_timestamp),
		};

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${source}: ${e instanceof Error ? e.message : String(e)}`);
		}

		// Track max page from extrinsic_index
		const pageNum = parseInt(tx.extrinsic_index.split("-")[0], 10);
		if (!isNaN(pageNum) && pageNum > maxPage) maxPage = pageNum;
	}

	// 4. Process rewards
	for (const reward of rewards) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const source = `bittensor:reward:${reward.event_index}`;
		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(reward)); } catch { /* may exist */ }

		const date = new Date(reward.block_timestamp * 1000).toISOString().slice(0, 10);
		const amount = raoToTao(reward.amount);

		const isReward = reward.event_id === "Rewarded";
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];

		if (isReward) {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: amount },
				{ account: STAKING_INCOME_ACCOUNT, currency: "TAO", amount: new Decimal(amount).neg().toFixed() },
			);
		} else {
			lineItemData.push(
				{ account: walletAssets(CHAIN, account.label), currency: "TAO", amount: new Decimal(amount).neg().toFixed() },
				{ account: STAKING_EXPENSE_ACCOUNT, currency: "TAO", amount: amount },
			);
		}

		const descData = rewardDescription(CHAIN, "staking", "TAO");
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
			"tao:event_index": reward.event_index,
			"tao:event_id": reward.event_id,
			"tao:amount": amount,
			"tao:block_timestamp": String(reward.block_timestamp),
			"tao:type": isReward ? "reward" : "slash",
		};

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${source}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 5. Update page cursor
	if (maxPage > (account.last_page ?? 0)) {
		await backend.updateBittensorSyncPage(account.id, maxPage);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
