// TON sync — fetch events via TonAPI and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchEvents } from "./api.js";
import type { TonAccount, TonSyncResult, TonEvent, TonAction } from "./types.js";

const CHAIN = "TON";
const TON_DECIMALS = 9;

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 6)}-${addr.slice(-4)}` : addr;
}

export async function syncTonAccount(
	backend: Backend,
	account: TonAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<TonSyncResult> {
	const result: TonSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch events
	onProgress?.("Fetching events...");
	const { events, cursor } = await fetchEvents(account.address, account.last_lt ?? undefined, signal);

	if (events.length === 0) {
		onProgress?.("No new events found.");
		return result;
	}

	onProgress?.(`Found ${events.length} events.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("ton:")) existingSources.add(e.source);
	}

	// Helpers (same pattern as Sui/Solana/Hyperliquid)
	async function ensureCurrency(code: string, decimals?: number): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: decimals ?? TON_DECIMALS, is_base: false });
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

	// 3. Process events
	const addr = account.address;

	for (let i = 0; i < events.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const event = events[i];
		const source = `ton:${event.event_id}`;

		onProgress?.(`Processing ${i + 1}/${events.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(event)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		if (event.is_scam) {
			result.transactions_skipped++;
			continue;
		}

		const date = new Date(event.timestamp * 1000).toISOString().slice(0, 10);

		// Build line items from actions
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let mainSymbol = "TON";
		let direction: "sent" | "received" | "self" = "self";

		for (const action of event.actions) {
			if (action.status !== "ok") continue;

			if (action.type === "TonTransfer" && action.TonTransfer) {
				const transfer = action.TonTransfer;
				const amountTon = new Decimal(transfer.amount).div(new Decimal(10).pow(TON_DECIMALS));
				if (amountTon.isZero()) continue;

				await ensureCurrency("TON");
				mainSymbol = "TON";

				const isSender = transfer.sender.address === addr;
				const isRecipient = transfer.recipient.address === addr;

				if (isRecipient) {
					direction = "received";
					lineItemData.push({
						account: walletAssets(CHAIN, account.label),
						currency: "TON",
						amount: amountTon.toFixed(),
					});
					lineItemData.push({
						account: walletExternal(CHAIN, accountPathAddr(transfer.sender.address)),
						currency: "TON",
						amount: amountTon.neg().toFixed(),
					});
				} else if (isSender) {
					direction = "sent";
					lineItemData.push({
						account: walletAssets(CHAIN, account.label),
						currency: "TON",
						amount: amountTon.neg().toFixed(),
					});
					lineItemData.push({
						account: walletExternal(CHAIN, accountPathAddr(transfer.recipient.address)),
						currency: "TON",
						amount: amountTon.toFixed(),
					});
				}
			} else if (action.type === "JettonTransfer" && action.JettonTransfer) {
				const transfer = action.JettonTransfer;
				const jetton = transfer.jetton;
				const symbol = jetton.symbol;
				const decimals = jetton.decimals;
				const amountJetton = new Decimal(transfer.amount).div(new Decimal(10).pow(decimals));
				if (amountJetton.isZero()) continue;

				await ensureCurrency(symbol, decimals);
				mainSymbol = symbol;

				const isSender = transfer.sender?.address === addr;
				const isRecipient = transfer.recipient?.address === addr;

				if (isRecipient) {
					direction = "received";
					lineItemData.push({
						account: walletAssets(CHAIN, account.label),
						currency: symbol,
						amount: amountJetton.toFixed(),
					});
					lineItemData.push({
						account: walletExternal(CHAIN, accountPathAddr(transfer.sender?.address ?? "unknown")),
						currency: symbol,
						amount: amountJetton.neg().toFixed(),
					});
				} else if (isSender) {
					direction = "sent";
					lineItemData.push({
						account: walletAssets(CHAIN, account.label),
						currency: symbol,
						amount: amountJetton.neg().toFixed(),
					});
					lineItemData.push({
						account: walletExternal(CHAIN, accountPathAddr(transfer.recipient?.address ?? "unknown")),
						currency: symbol,
						amount: amountJetton.toFixed(),
					});
				}
			}
			// Other action types (NftItemTransfer, ContractDeploy, etc.) are skipped
		}

		// Gas fee line items
		const feeTon = new Decimal(event.fee.total).div(new Decimal(10).pow(TON_DECIMALS));
		if (!feeTon.isZero()) {
			await ensureCurrency("TON");
			lineItemData.push({
				account: walletAssets(CHAIN, account.label),
				currency: "TON",
				amount: feeTon.neg().toFixed(),
			});
			lineItemData.push({
				account: chainFees(CHAIN),
				currency: "TON",
				amount: feeTon.toFixed(),
			});
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		// Build journal entry
		const descData = onchainTransferDescription(CHAIN, mainSymbol, direction, { txHash: event.event_id });
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
			"ton:event_id": event.event_id,
			"ton:direction": direction,
			"ton:asset": mainSymbol,
			"ton:timestamp": String(event.timestamp),
		};
		if (!feeTon.isZero()) meta["ton:fee"] = feeTon.toFixed();
		const actionTypes = event.actions.map((a) => a.type).join(",");
		if (actionTypes) meta["ton:action_types"] = actionTypes;

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${event.event_id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	if (cursor) {
		await backend.updateTonSyncCursor(account.id, cursor);
	}

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
