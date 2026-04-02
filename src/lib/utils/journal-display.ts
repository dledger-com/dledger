/**
 * Shared journal entry display utilities.
 * Used by both the dashboard (recent entries) and journal page (full table).
 */
import type { LineItem, CurrencyBalance } from "../types/index.js";
import { formatCurrency } from "./format.js";

export type AmountDirection = "income" | "expense" | "default";

export interface AmountSegment {
	amount: string;   // formatted number only, e.g. "1 234,56"
	currency: string; // e.g. "USDC"
}

export interface AmountPart {
	text: string;
	direction: AmountDirection;
	currencies: string[];
	segments: AmountSegment[];
	isTrade?: boolean;
}

// ── Account display ──────────────────────────────────────

function accountTail(fullPath: string): string {
	const parts = fullPath.split(":");
	return parts.length >= 2 ? parts.slice(-2).join(":") : fullPath;
}

function accountLeaf(fullPath: string): string {
	return fullPath.split(":").pop() ?? fullPath;
}

function isEquityTrading(name: string): boolean {
	return name === "Equity:Trading" || name.startsWith("Equity:Trading:");
}

function filterMeaningful(items: LineItem[], accountIdToName: Map<string, string>): LineItem[] {
	return items.filter(i => !isEquityTrading(accountIdToName.get(i.account_id) ?? ""));
}

function volumeByAccount(meaningful: LineItem[], accountIdToName: Map<string, string>): Map<string, number> {
	const map = new Map<string, number>();
	for (const item of meaningful) {
		const name = accountIdToName.get(item.account_id) ?? "";
		map.set(name, (map.get(name) ?? 0) + Math.abs(parseFloat(item.amount) || 0));
	}
	return map;
}

function highestVolumeAccount(meaningful: LineItem[], accountIdToName: Map<string, string>): string {
	const volumes = volumeByAccount(meaningful, accountIdToName);
	let best = accountIdToName.get(meaningful[0]?.account_id) ?? "";
	let bestVol = 0;
	for (const [name, vol] of volumes) {
		if (vol > bestVol) { best = name; bestVol = vol; }
	}
	return best;
}

function isCategory(name: string): boolean {
	return name.startsWith("Expenses:") || name.startsWith("Income:");
}

/**
 * Pick the best counterparty account to display.
 * When a single category exists alongside non-category accounts, only prefer the
 * category if its volume is >= the highest non-category volume (so fees don't win
 * over the main operation account).
 */
function pickCounterparty(
	unique: string[],
	meaningful: LineItem[],
	accountIdToName: Map<string, string>,
	formatter: (fullPath: string) => string,
	multiCategoryFormatter: (categories: string[]) => string,
): string {
	if (unique.length === 0) return "";
	if (unique.length === 1) return formatter(unique[0]);

	const categories = unique.filter(isCategory);
	if (categories.length === 1) {
		const nonCategories = unique.filter(a => !isCategory(a));
		if (nonCategories.length > 0) {
			const volumes = volumeByAccount(meaningful, accountIdToName);
			const catVol = volumes.get(categories[0]) ?? 0;
			const maxNonCatVol = Math.max(...nonCategories.map(a => volumes.get(a) ?? 0));
			if (maxNonCatVol > catVol) return formatter(highestVolumeAccount(meaningful, accountIdToName));
		}
		return formatter(categories[0]);
	}
	if (categories.length > 1) return multiCategoryFormatter(categories);
	return formatter(highestVolumeAccount(meaningful, accountIdToName));
}

/** Short account name (leaf only) for mobile displays. */
export function mainCounterpartyShort(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	return pickCounterparty(unique, meaningful, accountIdToName, accountLeaf, () => "Split");
}

/** Account name (last 2 segments) for normal displays. */
export function mainCounterparty(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	return pickCounterparty(unique, meaningful, accountIdToName, accountTail,
		cats => cats.map(a => a.split(":").pop() ?? "").join(" | "));
}

/** Full account path for tooltips. */
export function mainCounterpartyFull(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	return pickCounterparty(unique, meaningful, accountIdToName, a => a, cats => cats.join(" | "));
}

// ── Amount display ───────────────────────────────────────

/** CSS class for direction-colored amounts. */
export function amountColorClass(dir: AmountDirection): string {
	if (dir === "income") return "text-positive";
	if (dir === "expense") return "text-negative";
	return "";
}

function debitsByCurrency(items: LineItem[]): CurrencyBalance[] {
	const map = new Map<string, number>();
	for (const item of items) {
		const n = parseFloat(item.amount);
		if (n > 0) map.set(item.currency, (map.get(item.currency) ?? 0) + n);
	}
	return [...map].map(([currency, amount]) => ({ currency, amount: String(amount) }));
}

function isEquityTradingItem(item: LineItem, accountIdToName: Map<string, string>): boolean {
	return isEquityTrading(accountIdToName.get(item.account_id) ?? "");
}

/** Detect if entry is a trade and extract debit parts. */
export function entryAmountParts(items: LineItem[], accountIdToName: Map<string, string>): {
	isTrade: boolean;
	debits: CurrencyBalance[];
} {
	const equityItems = items.filter(i => isEquityTradingItem(i, accountIdToName));
	const nonEquityItems = items.filter(i => !isEquityTradingItem(i, accountIdToName));

	if (equityItems.length >= 2) {
		const spent = equityItems.find(e => parseFloat(e.amount) > 0);
		const received = equityItems.find(e => parseFloat(e.amount) < 0);
		if (spent && received && spent.currency !== received.currency) {
			return {
				isTrade: true,
				debits: [
					{ currency: spent.currency, amount: spent.amount },
					{ currency: received.currency, amount: String(Math.abs(parseFloat(received.amount))) },
				],
			};
		}
	}

	return { isTrade: false, debits: debitsByCurrency(nonEquityItems) };
}

/** Format entry amounts with direction for display. */
export function entryAmountDisplay(items: LineItem[], accountIdToName: Map<string, string>): AmountPart[] {
	const { isTrade, debits } = entryAmountParts(items, accountIdToName);

	// Trade: arrow format, plus any fees
	if (isTrade && debits.length === 2) {
		const parts: AmountPart[] = [{
			text: `${formatCurrency(debits[0].amount, debits[0].currency)} → ${formatCurrency(debits[1].amount, debits[1].currency)}`,
			direction: "default",
			currencies: [debits[0].currency, debits[1].currency],
			segments: [
				{ amount: debits[0].amount, currency: debits[0].currency },
				{ amount: debits[1].amount, currency: debits[1].currency },
			],
			isTrade: true,
		}];

		// Collect expense/fee items from non-equity line items
		const tradeExpenseByCode = new Map<string, number>();
		for (const item of items) {
			const name = accountIdToName.get(item.account_id) ?? "";
			if (name.startsWith("Expenses:") || name === "Expenses") {
				const n = parseFloat(item.amount);
				if (n > 0) tradeExpenseByCode.set(item.currency, (tradeExpenseByCode.get(item.currency) ?? 0) + n);
			}
		}
		if (tradeExpenseByCode.size > 0) {
			parts.push({
				text: [...tradeExpenseByCode].map(([c, a]) => formatCurrency(String(a), c)).join(", "),
				direction: "expense",
				currencies: [...tradeExpenseByCode.keys()],
				segments: [...tradeExpenseByCode].map(([c, a]) => ({ amount: String(a), currency: c })),
			});
		}

		return parts;
	}

	// Classify account types
	let hasIncome = false, hasExpense = false, hasEquity = false, hasNonExpenseDebit = false;
	for (const item of items) {
		const name = accountIdToName.get(item.account_id) ?? "";
		if (name.startsWith("Equity:") || name === "Equity") hasEquity = true;
		else if (name.startsWith("Income:") || name === "Income") hasIncome = true;
		else if (name.startsWith("Expenses:") || name === "Expenses") hasExpense = true;
		// Check for positive (debit) amounts on non-expense accounts (asset transfers)
		if (parseFloat(item.amount) > 0 && !name.startsWith("Expenses:") && name !== "Expenses") {
			hasNonExpenseDebit = true;
		}
	}

	// Mixed: expense+income/equity, OR expense alongside non-expense debits (e.g., fee + DeFi transfer)
	const isMixed = ((hasEquity || hasIncome) && hasExpense) || (hasExpense && hasNonExpenseDebit);
	if (!isMixed) {
		const dir: AmountDirection = hasIncome ? "income" : hasExpense ? "expense" : "default";
		const text = debits.length === 0 ? "" : debits.map(b => formatCurrency(b.amount, b.currency)).join(", ");
		return [{ text, direction: dir, currencies: debits.map(b => b.currency), segments: debits.map(b => ({ amount: b.amount, currency: b.currency })) }];
	}

	// Mixed: split expense from rest
	const expenseByCode = new Map<string, number>();
	for (const item of items) {
		const name = accountIdToName.get(item.account_id) ?? "";
		if (name.startsWith("Expenses:") || name === "Expenses") {
			const n = parseFloat(item.amount);
			if (n > 0) expenseByCode.set(item.currency, (expenseByCode.get(item.currency) ?? 0) + n);
		}
	}

	const mainByCode = new Map<string, number>();
	for (const d of debits) {
		const total = parseFloat(d.amount);
		const exp = expenseByCode.get(d.currency) ?? 0;
		const remainder = total - exp;
		if (remainder > 0.005) mainByCode.set(d.currency, remainder);
	}

	const parts: Array<{ text: string; direction: AmountDirection; total: number; currencies: string[]; segments: AmountSegment[] }> = [];
	const mainDir: AmountDirection = hasIncome ? "income" : "default";

	if (mainByCode.size > 0) {
		const total = [...mainByCode.values()].reduce((s, a) => s + a, 0);
		parts.push({ text: [...mainByCode].map(([c, a]) => formatCurrency(String(a), c)).join(", "), direction: mainDir, total, currencies: [...mainByCode.keys()], segments: [...mainByCode].map(([c, a]) => ({ amount: String(a), currency: c })) });
	}
	if (expenseByCode.size > 0) {
		const total = [...expenseByCode.values()].reduce((s, a) => s + a, 0);
		parts.push({ text: [...expenseByCode].map(([c, a]) => formatCurrency(String(a), c)).join(", "), direction: "expense", total, currencies: [...expenseByCode.keys()], segments: [...expenseByCode].map(([c, a]) => ({ amount: String(a), currency: c })) });
	}

	parts.sort((a, b) => b.total - a.total);
	return parts.map(({ text, direction, currencies, segments }) => ({ text, direction, currencies, segments }));
}
