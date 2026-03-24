/**
 * Shared journal entry display utilities.
 * Used by both the dashboard (recent entries) and journal page (full table).
 */
import type { LineItem, CurrencyBalance } from "../types/index.js";
import { formatCurrency } from "./format.js";

export type AmountDirection = "income" | "expense" | "default";

export interface AmountPart {
	text: string;
	direction: AmountDirection;
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

function highestVolumeAccount(meaningful: LineItem[], accountIdToName: Map<string, string>): string {
	const volumeByAccount = new Map<string, number>();
	for (const item of meaningful) {
		const name = accountIdToName.get(item.account_id) ?? "";
		volumeByAccount.set(name, (volumeByAccount.get(name) ?? 0) + Math.abs(parseFloat(item.amount) || 0));
	}
	let best = accountIdToName.get(meaningful[0]?.account_id) ?? "";
	let bestVol = 0;
	for (const [name, vol] of volumeByAccount) {
		if (vol > bestVol) { best = name; bestVol = vol; }
	}
	return best;
}

/** Short account name (leaf only) for mobile displays. */
export function mainCounterpartyShort(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	if (unique.length === 0) return "";
	if (unique.length === 1) return accountLeaf(unique[0]);
	const categories = unique.filter(a => a.startsWith("Expenses:") || a.startsWith("Income:"));
	if (categories.length === 1) return accountLeaf(categories[0]);
	if (categories.length > 1) return "Split";
	return accountLeaf(highestVolumeAccount(meaningful, accountIdToName));
}

/** Account name (last 2 segments) for normal displays. */
export function mainCounterparty(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	if (unique.length === 0) return "";
	if (unique.length === 1) return accountTail(unique[0]);
	const categories = unique.filter(a => a.startsWith("Expenses:") || a.startsWith("Income:"));
	if (categories.length === 1) return accountTail(categories[0]);
	if (categories.length > 1) return categories.map(a => a.split(":").pop() ?? "").join(" | ");
	return accountTail(highestVolumeAccount(meaningful, accountIdToName));
}

/** Full account path for tooltips. */
export function mainCounterpartyFull(items: LineItem[], accountIdToName: Map<string, string>): string {
	const meaningful = filterMeaningful(items, accountIdToName);
	const unique = [...new Set(meaningful.map(i => accountIdToName.get(i.account_id) ?? ""))];
	if (unique.length === 0) return "";
	if (unique.length === 1) return unique[0];
	const categories = unique.filter(a => a.startsWith("Expenses:") || a.startsWith("Income:"));
	if (categories.length === 1) return categories[0];
	if (categories.length > 1) return categories.join(" | ");
	return highestVolumeAccount(meaningful, accountIdToName);
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

	// Trade: arrow format
	if (isTrade && debits.length === 2) {
		return [{
			text: `${formatCurrency(debits[0].amount, debits[0].currency)} → ${formatCurrency(debits[1].amount, debits[1].currency)}`,
			direction: "default",
		}];
	}

	// Classify account types
	let hasIncome = false, hasExpense = false, hasEquity = false;
	for (const item of items) {
		const name = accountIdToName.get(item.account_id) ?? "";
		if (name.startsWith("Equity:") || name === "Equity") hasEquity = true;
		else if (name.startsWith("Income:") || name === "Income") hasIncome = true;
		else if (name.startsWith("Expenses:") || name === "Expenses") hasExpense = true;
	}

	// Single direction
	const isMixed = (hasEquity || hasIncome) && hasExpense;
	if (!isMixed) {
		const dir: AmountDirection = hasIncome ? "income" : hasExpense ? "expense" : "default";
		const text = debits.length === 0 ? "" : debits.map(b => formatCurrency(b.amount, b.currency)).join(", ");
		return [{ text, direction: dir }];
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

	const parts: Array<{ text: string; direction: AmountDirection; total: number }> = [];
	const mainDir: AmountDirection = hasIncome ? "income" : "default";

	if (mainByCode.size > 0) {
		const total = [...mainByCode.values()].reduce((s, a) => s + a, 0);
		parts.push({ text: [...mainByCode].map(([c, a]) => formatCurrency(String(a), c)).join(", "), direction: mainDir, total });
	}
	if (expenseByCode.size > 0) {
		const total = [...expenseByCode.values()].reduce((s, a) => s + a, 0);
		parts.push({ text: [...expenseByCode].map(([c, a]) => formatCurrency(String(a), c)).join(", "), direction: "expense", total });
	}

	parts.sort((a, b) => b.total - a.total);
	return parts.map(({ text, direction }) => ({ text, direction }));
}
