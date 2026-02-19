import type { Backend } from "$lib/backend.js";

export interface NetWorthPoint {
  date: Date;
  label: string;
  value: number;
}

export async function computeNetWorthSeries(
  backend: Backend,
  fromDate: string,
  toDate: string,
  baseCurrency: string,
): Promise<NetWorthPoint[]> {
  const points: NetWorthPoint[] = [];
  const from = new Date(fromDate);
  const to = new Date(toDate);

  // Generate month-end dates
  const dates: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth() + 1, 0); // last day of from month
  while (cursor <= to) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setMonth(cursor.getMonth() + 1);
    // Move to last day of next month
    cursor.setDate(0);
    cursor.setDate(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate());
  }

  // Always include the to date if not already included
  const toStr = to.toISOString().slice(0, 10);
  if (dates.length === 0 || dates[dates.length - 1] !== toStr) {
    dates.push(toStr);
  }

  const accounts = await backend.listAccounts();
  const assetAccounts = accounts.filter((a) => a.account_type === "asset" && a.is_postable);
  const liabilityAccounts = accounts.filter((a) => a.account_type === "liability" && a.is_postable);

  for (const date of dates) {
    let netWorth = 0;

    for (const account of assetAccounts) {
      const balances = await backend.getAccountBalance(account.id, date);
      for (const bal of balances) {
        if (bal.currency === baseCurrency) {
          netWorth += parseFloat(bal.amount);
        } else {
          const rate = await backend.getExchangeRate(bal.currency, baseCurrency, date);
          if (rate) {
            netWorth += parseFloat(bal.amount) * parseFloat(rate);
          }
        }
      }
    }

    for (const account of liabilityAccounts) {
      const balances = await backend.getAccountBalance(account.id, date);
      for (const bal of balances) {
        if (bal.currency === baseCurrency) {
          netWorth += parseFloat(bal.amount); // liabilities are negative
        } else {
          const rate = await backend.getExchangeRate(bal.currency, baseCurrency, date);
          if (rate) {
            netWorth += parseFloat(bal.amount) * parseFloat(rate);
          }
        }
      }
    }

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
  const accounts = await backend.listAccounts();
  const expenseAccounts = accounts.filter(
    (a) => a.account_type === "expense" && a.is_postable,
  );

  const categoryTotals = new Map<string, number>();

  for (const account of expenseAccounts) {
    // Get balance at end of period minus balance at start of period
    const endBalances = await backend.getAccountBalance(account.id, toDate);
    const startBalances = await backend.getAccountBalance(account.id, fromDate);

    for (const bal of endBalances) {
      const startBal = startBalances.find((s) => s.currency === bal.currency);
      const periodAmount = parseFloat(bal.amount) - (startBal ? parseFloat(startBal.amount) : 0);
      if (periodAmount <= 0) continue;

      let converted = periodAmount;
      if (bal.currency !== baseCurrency) {
        const rate = await backend.getExchangeRate(bal.currency, baseCurrency, toDate);
        if (rate) {
          converted = periodAmount * parseFloat(rate);
        } else {
          continue; // Skip if can't convert
        }
      }

      // Group by second-level: Expenses:Food:Restaurants → "Food"
      const parts = account.full_name.split(":");
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
