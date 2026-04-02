// Hyperliquid sync — fetch fills, funding, and ledger updates, create journal entries.

import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, tradeDescription, transferDescription, perpTradeDescription, fundingDescription } from "../types/description-data.js";
import { defiAssets, defiIncome, defiExpense, EQUITY_TRADING } from "../accounts/paths.js";
import { invalidate } from "../data/invalidation.js";
import { FIAT_CURRENCIES } from "../currency-type.js";
import { deriveAndRecordTradeRate, type TradeRateItem } from "../utils/derive-trade-rate.js";
import { fetchUserFills, fetchUserFunding, fetchUserLedgerUpdates, fetchSpotMeta } from "./api.js";
import type { HlSpotMeta } from "./api.js";
import type {
	HyperliquidAccount,
	HyperliquidSyncResult,
	HlFill,
	HlFundingDelta,
	HlLedgerUpdate,
} from "./types.js";

const PROTOCOL = "Hyperliquid";

// Account path helpers
const hlUsdcAccount = () => defiAssets(PROTOCOL, "USDC");
const hlSpotAccount = (coin: string) => defiAssets(PROTOCOL, `Spot:${coin}`);
const hlTradingIncome = () => defiIncome(PROTOCOL, "Trading");
const hlTradingExpense = () => defiExpense(PROTOCOL, "Trading");
const hlFundingIncome = () => defiIncome(PROTOCOL, "Funding");
const hlFundingExpense = () => defiExpense(PROTOCOL, "Funding");
const hlFees = () => defiExpense(PROTOCOL, "Fees");
const hlExternal = () => `Equity:Crypto:DeFi:${PROTOCOL}:External`;

/**
 * Sync a Hyperliquid account — fetch fills, funding, and ledger updates,
 * then create journal entries for realized cash flows.
 */
export async function syncHyperliquidAccount(
	backend: Backend,
	account: HyperliquidAccount,
	onProgress?: (msg: string) => void,
	signal?: AbortSignal,
): Promise<HyperliquidSyncResult> {
	const result: HyperliquidSyncResult = {
		fills_imported: 0,
		funding_imported: 0,
		ledger_imported: 0,
		skipped: 0,
		accounts_created: 0,
		warnings: [],
	};

	const startTime = account.last_sync_time ? account.last_sync_time + 1 : undefined;

	// 1. Fetch data streams
	onProgress?.("Fetching trade fills...");
	const fills = await fetchUserFills(account.address, startTime, signal);

	onProgress?.("Fetching funding payments...");
	const funding = await fetchUserFunding(account.address, startTime, signal);

	onProgress?.("Fetching ledger updates...");
	const ledger = await fetchUserLedgerUpdates(account.address, startTime, signal);

	if (fills.length === 0 && funding.length === 0 && ledger.length === 0) {
		onProgress?.("No new activity found.");
		return result;
	}

	onProgress?.(`Found ${fills.length} fills, ${funding.length} funding, ${ledger.length} ledger updates.`);

	// 1b. Fetch spot metadata if any fills use @index format
	const hasSpotIndexFills = fills.some(f => f.coin.startsWith("@"));
	let spotTokenMap: Map<number, string> | undefined; // tokenIndex → name
	let spotUniverseMap: Map<number, { base: string; quote: string }> | undefined; // universeIndex → pair
	if (hasSpotIndexFills) {
		onProgress?.("Fetching spot metadata...");
		try {
			const meta = await fetchSpotMeta(signal);
			spotTokenMap = new Map(meta.tokens.map(t => [t.index, t.name]));
			spotUniverseMap = new Map();
			for (const u of meta.universe) {
				const baseName = spotTokenMap.get(u.tokens[0]);
				const quoteName = spotTokenMap.get(u.tokens[1]);
				if (baseName && quoteName) {
					spotUniverseMap.set(u.index, { base: baseName, quote: quoteName });
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.warnings.push(`Failed to fetch spot metadata: ${msg}. Spot token names may be unresolved.`);
		}
	}

	function resolveSpotCoin(coin: string): { base: string; quote: string } | null {
		if (coin.includes("/")) {
			const [base, quote] = coin.split("/");
			return { base, quote: quote || "USDC" };
		}
		if (coin.startsWith("@") && spotUniverseMap) {
			const index = parseInt(coin.slice(1), 10);
			return spotUniverseMap.get(index) ?? null;
		}
		return null;
	}

	// 2. Build caches
	const newCurrencies: string[] = [];
	const currencySet = new Set(
		(await backend.listCurrencies()).map((c) => c.code),
	);
	const accountMap = new Map<string, Account>();
	for (const acc of await backend.listAccounts()) {
		accountMap.set(acc.full_name, acc);
	}
	const existingSources = new Set<string>();
	const allEntries = await backend.queryJournalEntries({});
	for (const [e] of allEntries) {
		if (e.source.startsWith("hyperliquid:")) {
			existingSources.add(e.source);
		}
	}

	// Context helpers (same pattern as Solana sync)
	async function ensureCurrency(code: string): Promise<void> {
		if (currencySet.has(code)) return;
		await backend.createCurrency({
			code,
			asset_type: "",
			param: "",
			name: code,
			decimal_places: 8,
			is_base: false,
		});
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

		const accountType = inferAccountType(fullName);
		const parts = fullName.split(":");
		let parentId: string | null = null;

		for (let depth = 1; depth < parts.length; depth++) {
			const ancestorName = parts.slice(0, depth).join(":");
			const existingAncestor = accountMap.get(ancestorName);
			if (existingAncestor) {
				parentId = existingAncestor.id;
			} else {
				const id = uuidv7();
				const acc: Account = {
					id,
					parent_id: parentId,
					account_type: accountType,
					name: parts[depth - 1],
					full_name: ancestorName,
					allowed_currencies: [],
					is_postable: true,
					is_archived: false,
					created_at: date,
				};
				await backend.createAccount(acc);
				accountMap.set(ancestorName, acc);
				result.accounts_created++;
				parentId = id;
			}
		}

		const id = uuidv7();
		const acc: Account = {
			id,
			parent_id: parentId,
			account_type: accountType,
			name: parts[parts.length - 1],
			full_name: fullName,
			allowed_currencies: [],
			is_postable: true,
			is_archived: false,
			created_at: date,
		};
		await backend.createAccount(acc);
		accountMap.set(fullName, acc);
		result.accounts_created++;
		return id;
	}

	async function postEntry(
		source: string,
		date: string,
		description: string,
		descriptionData: import("../types/description-data.js").DescriptionData,
		items: Array<{ account: string; currency: string; amount: string }>,
		metadata: Record<string, string>,
	): Promise<boolean> {
		if (existingSources.has(source)) return false;

		await ensureCurrency("USDC");

		const entryId = uuidv7();
		const entry: JournalEntry = {
			id: entryId,
			date,
			description,
			description_data: JSON.stringify(descriptionData),
			status: "confirmed",
			source,
			voided_by: null,
			created_at: date,
		};

		const lineItems: LineItem[] = [];
		for (const item of items) {
			await ensureCurrency(item.currency);
			const accountId = await ensureAccount(item.account, date);
			lineItems.push({
				id: uuidv7(),
				journal_entry_id: entryId,
				account_id: accountId,
				currency: item.currency,
				amount: item.amount,
				lot_id: null,
			});
		}

		try {
			await backend.postJournalEntry(entry, lineItems);
			if (Object.keys(metadata).length > 0) {
				await backend.setMetadata(entryId, metadata);
			}
			existingSources.add(source);
			return true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.warnings.push(`post ${source}: ${msg}`);
			return false;
		}
	}

	// Track max timestamp for cursor update
	let maxTime = account.last_sync_time ?? 0;
	function trackTime(t: number): void {
		if (t > maxTime) maxTime = t;
	}

	// 3. Process fills (grouped by hash)
	onProgress?.("Processing fills...");
	const fillsByHash = new Map<string, HlFill[]>();
	for (const fill of fills) {
		trackTime(fill.time);
		const group = fillsByHash.get(fill.hash) ?? [];
		group.push(fill);
		fillsByHash.set(fill.hash, group);
	}

	for (const [hash, group] of fillsByHash) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const source = `hyperliquid:fill:${hash}`;
		if (existingSources.has(source)) {
			result.skipped++;
			continue;
		}

		// Store raw data
		try {
			await backend.storeRawTransaction(source, JSON.stringify(group));
		} catch { /* may already exist */ }

		const first = group[0];
		const date = new Date(first.time).toISOString().slice(0, 10);
		const isSpot = first.coin.includes("/") || first.coin.startsWith("@");

		if (isSpot) {
			// Spot trade: resolve "@128" → DEPIN or "PURR/USDC" → PURR
			const resolved = resolveSpotCoin(first.coin);
			if (!resolved) {
				result.warnings.push(`Unresolved spot coin: ${first.coin} (hash ${hash})`);
				result.skipped++;
				continue;
			}
			const base = resolved.base;
			const totalSz = group.reduce((sum, f) => sum.plus(f.sz), new Decimal(0));
			const totalFee = group.reduce((sum, f) => sum.plus(f.fee), new Decimal(0));
			const isBuy = first.side === "B";

			// Weighted average price
			const totalValue = group.reduce(
				(sum, f) => sum.plus(new Decimal(f.sz).times(f.px)),
				new Decimal(0),
			);

			const items: Array<{ account: string; currency: string; amount: string }> = [];

			if (isBuy) {
				// Buy: receive base, spend USDC
				items.push({ account: hlSpotAccount(base), currency: base, amount: totalSz.toFixed() });
				items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalValue.neg().toFixed() });
			} else {
				// Sell: spend base, receive USDC
				items.push({ account: hlSpotAccount(base), currency: base, amount: totalSz.neg().toFixed() });
				items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalValue.toFixed() });
			}

			// Trading equity
			const equityAmount = isBuy ? totalValue.toFixed() : totalValue.neg().toFixed();
			items.push({ account: `${EQUITY_TRADING}:${base}`, currency: "USDC", amount: equityAmount });
			const baseEquity = isBuy ? totalSz.neg().toFixed() : totalSz.toFixed();
			items.push({ account: `${EQUITY_TRADING}:${base}`, currency: base, amount: baseEquity });

			// Fee
			if (totalFee.gt(0)) {
				items.push({ account: hlFees(), currency: "USDC", amount: totalFee.toFixed() });
				items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalFee.neg().toFixed() });
			}

			const descData = tradeDescription("Hyperliquid", isBuy ? "USDC" : base, isBuy ? base : "USDC");
			const posted = await postEntry(source, date, renderDescription(descData), descData, items, {
				hl_coin: first.coin, hl_side: first.side, hl_hash: hash,
			});
			if (posted) {
				const rateItems: TradeRateItem[] = items.map((i) => ({
					account_name: i.account,
					currency: i.currency,
					amount: i.amount,
				}));
				await deriveAndRecordTradeRate(backend, date, rateItems);
				result.fills_imported++;
			} else {
				result.skipped++;
			}
		} else {
			// Perp trade: only record realized PnL and fees
			const totalClosedPnl = group.reduce((sum, f) => sum.plus(f.closedPnl), new Decimal(0));
			const totalFee = group.reduce((sum, f) => sum.plus(f.fee), new Decimal(0));
			const side = first.dir.toLowerCase().includes("long") ? "long" as const : "short" as const;

			const items: Array<{ account: string; currency: string; amount: string }> = [];

			// Realized PnL (only if non-zero)
			if (!totalClosedPnl.isZero()) {
				if (totalClosedPnl.gt(0)) {
					items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalClosedPnl.toFixed() });
					items.push({ account: hlTradingIncome(), currency: "USDC", amount: totalClosedPnl.neg().toFixed() });
				} else {
					items.push({ account: hlTradingExpense(), currency: "USDC", amount: totalClosedPnl.abs().toFixed() });
					items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalClosedPnl.toFixed() });
				}
			}

			// Fee
			if (totalFee.gt(0)) {
				items.push({ account: hlFees(), currency: "USDC", amount: totalFee.toFixed() });
				items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalFee.neg().toFixed() });
			}

			// Skip if no PnL and no fee (pure open with zero fee)
			if (items.length === 0) {
				result.skipped++;
				continue;
			}

			const descData = perpTradeDescription("Hyperliquid", first.coin, side);
			const posted = await postEntry(source, date, renderDescription(descData), descData, items, {
				hl_coin: first.coin, hl_side: first.side, hl_dir: first.dir,
				hl_hash: hash, hl_pnl: totalClosedPnl.toFixed(),
			});
			if (posted) result.fills_imported++;
			else result.skipped++;
		}
	}

	// 4. Process funding (aggregated by day + coin)
	onProgress?.("Processing funding payments...");
	const fundingByDayCoin = new Map<string, { records: HlFundingDelta[]; totalUsdc: Decimal }>();
	for (const f of funding) {
		trackTime(f.time);
		const date = new Date(f.time).toISOString().slice(0, 10);
		const key = `${date}:${f.coin}`;
		const existing = fundingByDayCoin.get(key);
		if (existing) {
			existing.records.push(f);
			existing.totalUsdc = existing.totalUsdc.plus(f.usdc);
		} else {
			fundingByDayCoin.set(key, { records: [f], totalUsdc: new Decimal(f.usdc) });
		}
	}

	for (const [key, { records, totalUsdc }] of fundingByDayCoin) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const [date, coin] = key.split(":", 2);
		const source = `hyperliquid:funding:${key}`;

		if (existingSources.has(source)) {
			result.skipped++;
			continue;
		}

		// Store raw records
		try {
			await backend.storeRawTransaction(source, JSON.stringify(records));
		} catch { /* may already exist */ }

		if (totalUsdc.isZero()) {
			result.skipped++;
			continue;
		}

		const items: Array<{ account: string; currency: string; amount: string }> = [];
		if (totalUsdc.gt(0)) {
			// Funding received
			items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalUsdc.toFixed() });
			items.push({ account: hlFundingIncome(), currency: "USDC", amount: totalUsdc.neg().toFixed() });
		} else {
			// Funding paid
			items.push({ account: hlFundingExpense(), currency: "USDC", amount: totalUsdc.abs().toFixed() });
			items.push({ account: hlUsdcAccount(), currency: "USDC", amount: totalUsdc.toFixed() });
		}

		const descData = fundingDescription("Hyperliquid", coin);
		const posted = await postEntry(source, date, renderDescription(descData), descData, items, {
			hl_coin: coin, hl_funding_records: String(records.length),
		});
		if (posted) result.funding_imported++;
		else result.skipped++;
	}

	// 5. Process ledger updates (deposits, withdrawals, liquidations)
	onProgress?.("Processing ledger updates...");
	// Sort by time for sequential processing
	const sortedLedger = [...ledger].sort((a, b) => a.time - b.time);

	for (const update of sortedLedger) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		trackTime(update.time);

		const source = `hyperliquid:ledger:${update.hash}`;
		if (existingSources.has(source)) {
			result.skipped++;
			continue;
		}

		// Store raw data
		try {
			await backend.storeRawTransaction(source, JSON.stringify(update));
		} catch { /* may already exist */ }

		const date = new Date(update.time).toISOString().slice(0, 10);
		const delta = update.delta;

		switch (delta.type) {
			case "deposit": {
				const usdc = new Decimal(delta.usdc);
				if (usdc.isZero()) { result.skipped++; continue; }

				const descData = transferDescription("Hyperliquid", "deposit", "USDC");
				const posted = await postEntry(source, date, renderDescription(descData), descData, [
					{ account: hlUsdcAccount(), currency: "USDC", amount: usdc.toFixed() },
					{ account: hlExternal(), currency: "USDC", amount: usdc.neg().toFixed() },
				], { hl_hash: update.hash, hl_type: "deposit", txid: update.hash });
				if (posted) result.ledger_imported++;
				else result.skipped++;
				break;
			}
			case "withdraw": {
				const usdc = new Decimal(delta.usdc);
				const fee = new Decimal(delta.fee);
				if (usdc.isZero()) { result.skipped++; continue; }

				const items: Array<{ account: string; currency: string; amount: string }> = [
					{ account: hlExternal(), currency: "USDC", amount: usdc.toFixed() },
					{ account: hlUsdcAccount(), currency: "USDC", amount: usdc.neg().toFixed() },
				];
				// Withdrawal fee
				if (fee.gt(0)) {
					items.push({ account: hlFees(), currency: "USDC", amount: fee.toFixed() });
					items.push({ account: hlUsdcAccount(), currency: "USDC", amount: fee.neg().toFixed() });
				}

				const descData = transferDescription("Hyperliquid", "withdrawal", "USDC");
				const posted = await postEntry(source, date, renderDescription(descData), descData, items, {
					hl_hash: update.hash, hl_type: "withdrawal", txid: update.hash,
				});
				if (posted) result.ledger_imported++;
				else result.skipped++;
				break;
			}
			case "liquidation": {
				// Liquidation: we don't have an explicit USDC amount in the delta.
				// The realized loss comes through as fills with closedPnl, so we just record a marker entry.
				// Skip if no items to post (the fill processing handles the PnL).
				result.skipped++;
				break;
			}
			case "internalTransfer":
			case "spotTransfer":
			case "accountClassTransfer":
			case "subAccountTransfer":
			case "vaultDeposit":
			case "vaultWithdraw":
				// Internal moves — zero-sum within Hyperliquid, skip
				result.skipped++;
				break;
			default:
				result.skipped++;
				break;
		}
	}

	// 6. Update sync cursor
	if (maxTime > (account.last_sync_time ?? 0)) {
		await backend.updateHyperliquidSyncCursor(account.id, maxTime);
	}

	onProgress?.(`Done: ${result.fills_imported} fills, ${result.funding_imported} funding, ${result.ledger_imported} ledger.`);

	invalidate("journal", "accounts", "reports");


	// Reclassify newly created currencies as crypto
	for (const code of newCurrencies) {
		const type = FIAT_CURRENCIES.has(code) ? "fiat" : "crypto";
		try { await backend.setCurrencyAssetType(code, type); } catch { /* may already be classified */ }
	}

	return result;
}
