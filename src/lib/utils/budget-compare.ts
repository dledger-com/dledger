import type { Backend } from "$lib/backend.js";
import type { Budget, BudgetComparison, BudgetReport } from "$lib/types/index.js";

/**
 * Compute budget vs actual report for a given period.
 * Uses income statement data to compare against budget targets.
 * Account pattern matching: exact match or prefix (e.g. "Expenses:Food" matches "Expenses:Food:Groceries").
 */
export async function computeBudgetReport(
  backend: Backend,
  budgets: Budget[],
  fromDate: string,
  toDate: string,
): Promise<BudgetReport> {
  const incomeStatement = await backend.incomeStatement(fromDate, toDate);

  // Build a flat map of account_name → total absolute amount per currency
  const accountAmounts = new Map<string, Map<string, number>>();

  for (const section of [incomeStatement.revenue, incomeStatement.expenses]) {
    for (const line of section.lines) {
      const byC = new Map<string, number>();
      for (const b of line.balances) {
        byC.set(b.currency, Math.abs(parseFloat(b.amount)));
      }
      accountAmounts.set(line.account_name, byC);
    }
  }

  const comparisons: BudgetComparison[] = [];

  for (const budget of budgets) {
    // Check if budget is active for this period
    if (budget.start_date && fromDate < budget.start_date) continue;
    if (budget.end_date && toDate > budget.end_date) continue;

    // Sum actual spending matching the pattern
    let actual = 0;
    for (const [accountName, amounts] of accountAmounts) {
      if (matchesPattern(accountName, budget.account_pattern)) {
        actual += amounts.get(budget.currency) ?? 0;
      }
    }

    const budgetAmount = parseFloat(budget.amount);
    const remaining = budgetAmount - actual;
    const percentUsed = budgetAmount > 0 ? (actual / budgetAmount) * 100 : 0;

    comparisons.push({
      budget,
      actual,
      remaining,
      percent_used: percentUsed,
    });
  }

  return { from_date: fromDate, to_date: toDate, comparisons };
}

function matchesPattern(accountName: string, pattern: string): boolean {
  return accountName === pattern || accountName.startsWith(pattern + ":");
}
