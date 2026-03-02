import type { ConvertedSummary } from "$lib/utils/currency-convert.js";
import type { NetWorthPoint, ExpenseCategory } from "$lib/utils/balance-history.js";
import type { JournalEntry, LineItem } from "$lib/types/index.js";

// Recent entries
let _recentEntries = $state<[JournalEntry, LineItem[]][]>([]);
let _recentLoaded = false;

export function getCachedRecentEntries() { return { entries: _recentEntries, loaded: _recentLoaded }; }
export function setCachedRecentEntries(entries: [JournalEntry, LineItem[]][]) {
  _recentEntries = entries;
  _recentLoaded = true;
}

// Converted summaries
let _assets = $state<ConvertedSummary | null>(null);
let _liabilities = $state<ConvertedSummary | null>(null);
let _revenue = $state<ConvertedSummary | null>(null);
let _netIncome = $state<ConvertedSummary | null>(null);

export function getCachedSummaries() {
  return { assets: _assets, liabilities: _liabilities, revenue: _revenue, netIncome: _netIncome };
}
export function setCachedSummary(key: "assets" | "liabilities" | "revenue" | "netIncome", value: ConvertedSummary) {
  if (key === "assets") _assets = value;
  else if (key === "liabilities") _liabilities = value;
  else if (key === "revenue") _revenue = value;
  else _netIncome = value;
}

// Chart data
let _netWorthData = $state<NetWorthPoint[]>([]);
let _expenseData = $state<ExpenseCategory[]>([]);
let _chartsLoaded = false;

export function getCachedCharts() { return { netWorth: _netWorthData, expenses: _expenseData, loaded: _chartsLoaded }; }
export function setCachedCharts(netWorth: NetWorthPoint[], expenses: ExpenseCategory[]) {
  _netWorthData = netWorth;
  _expenseData = expenses;
  _chartsLoaded = true;
}
