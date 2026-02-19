import type { Backend } from "$lib/backend.js";
import type { CurrencyBalance } from "$lib/types/report.js";

export interface NetWorthPoint {
  date: Date;
  label: string;
  value: number;
}

/** Caches exchange rate lookups for the lifetime of a computation. */
class ExchangeRateCache {
  private cache = new Map<string, string | null>();
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  async get(from: string, to: string, date: string): Promise<string | null> {
    const key = `${from}:${to}:${date}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const rate = await this.backend.getExchangeRate(from, to, date);
    this.cache.set(key, rate);
    return rate;
  }
}

async function convertBalances(
  balances: CurrencyBalance[],
  baseCurrency: string,
  date: string,
  rateCache: ExchangeRateCache,
): Promise<number> {
  let total = 0;
  for (const bal of balances) {
    const amount = parseFloat(bal.amount);
    if (bal.currency === baseCurrency) {
      total += amount;
    } else {
      const rate = await rateCache.get(bal.currency, baseCurrency, date);
      if (rate) {
        total += amount * parseFloat(rate);
      }
    }
  }
  return total;
}

function monthEndDates(from: Date, to: Date): string[] {
  const dates: string[] = [];
  let year = from.getFullYear();
  let month = from.getMonth(); // 0-indexed

  while (true) {
    // Last day of this month
    const lastDay = new Date(year, month + 1, 0);
    if (lastDay > to) break;
    dates.push(lastDay.toISOString().slice(0, 10));
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  // Always include the final date
  const toStr = to.toISOString().slice(0, 10);
  if (dates.length === 0 || dates[dates.length - 1] !== toStr) {
    dates.push(toStr);
  }

  return dates;
}

export async function computeNetWorthSeries(
  backend: Backend,
  fromDate: string,
  toDate: string,
  baseCurrency: string,
): Promise<NetWorthPoint[]> {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const dates = monthEndDates(from, to);
  const rateCache = new ExchangeRateCache(backend);

  const points: NetWorthPoint[] = [];

  for (const date of dates) {
    const sheet = await backend.balanceSheet(date);
    const assets = await convertBalances(sheet.assets.totals, baseCurrency, date, rateCache);
    const liabilities = await convertBalances(sheet.liabilities.totals, baseCurrency, date, rateCache);
    const netWorth = assets + liabilities; // liabilities are already negative

    const d = new Date(date + "T00:00:00");
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    points.push({ date: d, label, value: Math.round(netWorth * 100) / 100 });
  }

  return points;
}

export interface ExpenseCategory {
  category: string;
  amount: number;
  color: string;
}

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--muted-foreground))",
];

export async function computeExpenseBreakdown(
  backend: Backend,
  fromDate: string,
  toDate: string,
  baseCurrency: string,
  maxCategories = 6,
): Promise<ExpenseCategory[]> {
  const stmt = await backend.incomeStatement(fromDate, toDate);
  const rateCache = new ExchangeRateCache(backend);
  const categoryTotals = new Map<string, number>();

  for (const line of stmt.expenses.lines) {
    for (const bal of line.balances) {
      const amount = parseFloat(bal.amount);
      if (amount <= 0) continue;

      let converted = amount;
      if (bal.currency !== baseCurrency) {
        const rate = await rateCache.get(bal.currency, baseCurrency, toDate);
        if (rate) {
          converted = amount * parseFloat(rate);
        } else {
          continue;
        }
      }

      // Group by second-level: Expenses:Food:Restaurants → "Food"
      const parts = line.account_name.split(":");
      const category = parts.length >= 2 ? parts[1] : parts[0];
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + converted);
    }
  }

  // Sort by amount descending
  const sorted = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);

  const categories: ExpenseCategory[] = [];
  let otherTotal = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (i < maxCategories - 1 || sorted.length <= maxCategories) {
      categories.push({
        category: sorted[i][0],
        amount: Math.round(sorted[i][1] * 100) / 100,
        color: CHART_COLORS[i % CHART_COLORS.length],
      });
    } else {
      otherTotal += sorted[i][1];
    }
  }

  if (otherTotal > 0) {
    categories.push({
      category: "Other",
      amount: Math.round(otherTotal * 100) / 100,
      color: CHART_COLORS[CHART_COLORS.length - 1],
    });
  }

  return categories;
}
