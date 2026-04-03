// Cosmos sync — fetch transactions via LCD API and create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, onchainTransferDescription } from "../types/description-data.js";
import { walletAssets, chainFees, walletExternal } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { fetchTransactions } from "./api.js";
import type { CosmosAccount, CosmosSyncResult, CosmosTxResponse, CosmosMessage } from "./types.js";

const CHAIN = "Cosmos";

/** Parse denom: uatom → ATOM (divide by 10^6). IBC denoms → raw hash. */
function parseDenom(denom: string): { symbol: string; exponent: number } {
	if (denom === "uatom") return { symbol: "ATOM", exponent: 6 };
	// IBC denoms like ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2
	if (denom.startsWith("ibc/")) return { symbol: denom, exponent: 0 };
	// Other micro-denoms (e.g., uosmo, ustake)
	if (denom.startsWith("u")) return { symbol: denom.slice(1).toUpperCase(), exponent: 6 };
	return { symbol: denom.toUpperCase(), exponent: 0 };
}

function shortAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : addr;
}

function accountPathAddr(addr: string): string {
	return addr.length > 12 ? `${addr.slice(0, 10)}-${addr.slice(-4)}` : addr;
}

export async function syncCosmosAccount(
	backend: Backend,
	account: CosmosAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<CosmosSyncResult> {
	const result: CosmosSyncResult = {
		transactions_imported: 0,
		transactions_skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	// 1. Fetch transactions
	onProgress?.("Fetching transactions...");
	const { txs } = await fetchTransactions(account.address, account.last_offset ?? undefined, signal);

	if (txs.length === 0) {
		onProgress?.("No new transactions found.");
		return result;
	}

	onProgress?.(`Found ${txs.length} transactions.`);

	// 2. Build caches
	const currencySet = new Set((await backend.listCurrencies()).map(c => c.code));
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) accountMap.set(acc.full_name, acc);
	const existingSources = new Set<string>();
	for (const [e] of await backend.queryJournalEntries({})) {
		if (e.source.startsWith("cosmos:")) existingSources.add(e.source);
	}

	// Helpers (same pattern as Sui/Solana/Hyperliquid)
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		const assetType = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		await backend.createCurrency({ code, asset_type: assetType, param: "", name: code, decimal_places: 6, is_base: false });
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
	const addr = account.address.toLowerCase();

	for (let i = 0; i < txs.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tx = txs[i];
		const source = `cosmos:${tx.txhash}`;

		onProgress?.(`Processing ${i + 1}/${txs.length}...`);

		// Store raw
		try { await backend.storeRawTransaction(source, JSON.stringify(tx)); } catch { /* may exist */ }

		if (existingSources.has(source)) {
			result.transactions_skipped++;
			continue;
		}

		// Skip failed transactions
		if (tx.code !== 0) {
			result.transactions_skipped++;
			continue;
		}

		const date = tx.timestamp
			? new Date(tx.timestamp).toISOString().slice(0, 10)
			: new Date().toISOString().slice(0, 10);

		// Build line items from messages
		const lineItemData: Array<{ account: string; currency: string; amount: string }> = [];
		let mainSymbol = "ATOM";
		let direction: "sent" | "received" | "self" = "self";

		for (const msg of tx.tx.body.messages) {
			const msgType = msg["@type"];

			if (msgType === "/cosmos.bank.v1beta1.MsgSend") {
				const m = msg as Extract<CosmosMessage, { "@type": "/cosmos.bank.v1beta1.MsgSend" }>;
				const isSender = m.from_address.toLowerCase() === addr;
				const isReceiver = m.to_address.toLowerCase() === addr;
				if (!isSender && !isReceiver) continue;

				for (const coin of m.amount) {
					const { symbol, exponent } = parseDenom(coin.denom);
					const rawAmount = new Decimal(coin.amount).div(new Decimal(10).pow(exponent));
					await ensureCurrency(symbol);
					mainSymbol = symbol;

					if (isSender) {
						direction = "sent";
						const counterparty = accountPathAddr(m.to_address);
						lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.neg().toFixed() });
						lineItemData.push({ account: walletExternal(CHAIN, counterparty), currency: symbol, amount: rawAmount.toFixed() });
					} else {
						direction = "received";
						const counterparty = accountPathAddr(m.from_address);
						lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.toFixed() });
						lineItemData.push({ account: walletExternal(CHAIN, counterparty), currency: symbol, amount: rawAmount.neg().toFixed() });
					}
				}
			} else if (msgType === "/cosmos.staking.v1beta1.MsgDelegate") {
				const m = msg as Extract<CosmosMessage, { "@type": "/cosmos.staking.v1beta1.MsgDelegate" }>;
				if (m.delegator_address.toLowerCase() !== addr) continue;
				const { symbol, exponent } = parseDenom(m.amount.denom);
				const rawAmount = new Decimal(m.amount.amount).div(new Decimal(10).pow(exponent));
				await ensureCurrency(symbol);
				mainSymbol = symbol;
				direction = "sent";

				// Debit staking account, credit wallet
				const stakingAccount = `Assets:Crypto:Staking:Cosmos:${account.label}`;
				lineItemData.push({ account: stakingAccount, currency: symbol, amount: rawAmount.toFixed() });
				lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.neg().toFixed() });
			} else if (msgType === "/cosmos.staking.v1beta1.MsgUndelegate") {
				const m = msg as Extract<CosmosMessage, { "@type": "/cosmos.staking.v1beta1.MsgUndelegate" }>;
				if (m.delegator_address.toLowerCase() !== addr) continue;
				const { symbol, exponent } = parseDenom(m.amount.denom);
				const rawAmount = new Decimal(m.amount.amount).div(new Decimal(10).pow(exponent));
				await ensureCurrency(symbol);
				mainSymbol = symbol;
				direction = "received";

				// Reverse of delegate: debit wallet, credit staking
				const stakingAccount = `Assets:Crypto:Staking:Cosmos:${account.label}`;
				lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.toFixed() });
				lineItemData.push({ account: stakingAccount, currency: symbol, amount: rawAmount.neg().toFixed() });
			} else if (msgType === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward") {
				const m = msg as Extract<CosmosMessage, { "@type": "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward" }>;
				if (m.delegator_address.toLowerCase() !== addr) continue;
				// Rewards are in ATOM — exact amount is in events, but we use a placeholder
				// The actual reward amount comes from the transaction events, not the message itself
				mainSymbol = "ATOM";
				direction = "received";
				// Note: actual reward amounts would need event parsing; skip line items if no amount available
			} else if (msgType === "/ibc.applications.transfer.v1.MsgTransfer") {
				const m = msg as Extract<CosmosMessage, { "@type": "/ibc.applications.transfer.v1.MsgTransfer" }>;
				const isSender = m.sender.toLowerCase() === addr;
				const isReceiver = m.receiver.toLowerCase() === addr;
				if (!isSender && !isReceiver) continue;

				const { symbol, exponent } = parseDenom(m.token.denom);
				const rawAmount = new Decimal(m.token.amount).div(new Decimal(10).pow(exponent));
				await ensureCurrency(symbol);
				mainSymbol = symbol;

				if (isSender) {
					direction = "sent";
					const counterparty = accountPathAddr(m.receiver);
					lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.neg().toFixed() });
					lineItemData.push({ account: walletExternal(CHAIN, counterparty), currency: symbol, amount: rawAmount.toFixed() });
				} else {
					direction = "received";
					const counterparty = accountPathAddr(m.sender);
					lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: rawAmount.toFixed() });
					lineItemData.push({ account: walletExternal(CHAIN, counterparty), currency: symbol, amount: rawAmount.neg().toFixed() });
				}
			}
			// Other message types: skip
		}

		// Add gas fees
		const feeAmounts = tx.tx.auth_info.fee.amount;
		for (const fee of feeAmounts) {
			const { symbol, exponent } = parseDenom(fee.denom);
			const feeAmount = new Decimal(fee.amount).div(new Decimal(10).pow(exponent));
			if (feeAmount.isZero()) continue;
			await ensureCurrency(symbol);

			lineItemData.push({ account: walletAssets(CHAIN, account.label), currency: symbol, amount: feeAmount.neg().toFixed() });
			lineItemData.push({ account: chainFees(CHAIN), currency: symbol, amount: feeAmount.toFixed() });
		}

		if (lineItemData.length === 0) {
			result.transactions_skipped++;
			continue;
		}

		// Build journal entry
		const descData = onchainTransferDescription(CHAIN, mainSymbol, direction, { txHash: tx.txhash });
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
			"cosmos:txhash": tx.txhash,
			"cosmos:direction": direction,
			"cosmos:asset": mainSymbol,
		};
		const msgTypes = tx.tx.body.messages.map((m) => m["@type"]).join(",");
		if (msgTypes) meta["cosmos:msg_types"] = msgTypes;
		const feeStr = feeAmounts.map((f) => `${f.amount}${f.denom}`).join(",");
		if (feeStr) meta["cosmos:fee"] = feeStr;

		try {
			await backend.postJournalEntry(entry, lineItems);
			await backend.setMetadata(entryId, meta);
			existingSources.add(source);
			result.transactions_imported++;
		} catch (e) {
			result.warnings.push(`post ${tx.txhash.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 4. Update cursor
	const newOffset = (account.last_offset ?? 0) + txs.length;
	await backend.updateCosmosSyncOffset(account.id, newOffset);

	onProgress?.(`Done: ${result.transactions_imported} imported, ${result.transactions_skipped} skipped.`);
	invalidate("journal", "accounts", "reports");

	return result;
}
