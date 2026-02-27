import type { Backend } from "$lib/backend.js";
import type { Account } from "$lib/types/index.js";
import { defiIncomePrefix, defiExpensePrefix } from "$lib/accounts/paths.js";

export interface ProtocolPnLLine {
  currency: string;
  amount: string;
}

export interface ProtocolPnL {
  protocol: string;
  displayName: string;
  revenue: ProtocolPnLLine[];
  expenses: ProtocolPnLLine[];
  revenueBase?: string;
  expensesBase?: string;
  netIncomeBase?: string;
}

const PROTOCOL_PATTERNS: {
  prefix: string;
  protocol: string;
  displayName: string;
  type: "revenue" | "expense";
}[] = [
  { prefix: defiIncomePrefix("Aave"), protocol: "aave", displayName: "Aave", type: "revenue" },
  { prefix: defiIncomePrefix("Compound"), protocol: "compound", displayName: "Compound", type: "revenue" },
  { prefix: defiIncomePrefix("Uniswap"), protocol: "uniswap", displayName: "Uniswap", type: "revenue" },
  { prefix: defiIncomePrefix("Curve"), protocol: "curve", displayName: "Curve", type: "revenue" },
  { prefix: defiIncomePrefix("Pendle"), protocol: "pendle", displayName: "Pendle", type: "revenue" },
  { prefix: defiIncomePrefix("Lido"), protocol: "lido", displayName: "Lido", type: "revenue" },
  { prefix: defiExpensePrefix("Aave"), protocol: "aave", displayName: "Aave", type: "expense" },
  { prefix: defiExpensePrefix("Compound"), protocol: "compound", displayName: "Compound", type: "expense" },
  { prefix: defiExpensePrefix("Uniswap"), protocol: "uniswap", displayName: "Uniswap", type: "expense" },
  { prefix: defiExpensePrefix("Curve"), protocol: "curve", displayName: "Curve", type: "expense" },
  { prefix: defiExpensePrefix("Pendle"), protocol: "pendle", displayName: "Pendle", type: "expense" },
  { prefix: defiExpensePrefix("Lido"), protocol: "lido", displayName: "Lido", type: "expense" },
  { prefix: defiIncomePrefix("Yearn"), protocol: "yearn", displayName: "Yearn", type: "revenue" },
  { prefix: defiExpensePrefix("Yearn"), protocol: "yearn", displayName: "Yearn", type: "expense" },
  { prefix: defiIncomePrefix("Balancer"), protocol: "balancer", displayName: "Balancer", type: "revenue" },
  { prefix: defiExpensePrefix("Balancer"), protocol: "balancer", displayName: "Balancer", type: "expense" },
  { prefix: defiIncomePrefix("Spark"), protocol: "maker", displayName: "MakerDAO/Spark", type: "revenue" },
  { prefix: defiExpensePrefix("Spark"), protocol: "maker", displayName: "MakerDAO/Spark", type: "expense" },
  { prefix: defiIncomePrefix("EigenLayer"), protocol: "eigenlayer", displayName: "EigenLayer", type: "revenue" },
  { prefix: defiExpensePrefix("EigenLayer"), protocol: "eigenlayer", displayName: "EigenLayer", type: "expense" },
];

interface ProtocolAccountMatch {
  account: Account;
  protocol: string;
  displayName: string;
  type: "revenue" | "expense";
}

function matchAccountToProtocol(account: Account): ProtocolAccountMatch | null {
  for (const pattern of PROTOCOL_PATTERNS) {
    if (account.full_name.startsWith(pattern.prefix)) {
      return {
        account,
        protocol: pattern.protocol,
        displayName: pattern.displayName,
        type: pattern.type,
      };
    }
  }
  return null;
}

/**
 * Merge currency amounts, summing amounts for the same currency.
 */
function mergeLines(lines: ProtocolPnLLine[]): ProtocolPnLLine[] {
  const byCurrency = new Map<string, number>();
  for (const line of lines) {
    const prev = byCurrency.get(line.currency) ?? 0;
    byCurrency.set(line.currency, prev + parseFloat(line.amount));
  }
  return Array.from(byCurrency.entries())
    .filter(([, amount]) => Math.abs(amount) > 1e-8)
    .map(([currency, amount]) => ({ currency, amount: amount.toString() }));
}

export async function computeProtocolPnL(
  backend: Backend,
  fromDate: string,
  toDate: string,
  baseCurrency: string,
): Promise<ProtocolPnL[]> {
  const accounts = await backend.listAccounts();

  // Match accounts to protocols
  const matches: ProtocolAccountMatch[] = [];
  for (const account of accounts) {
    const match = matchAccountToProtocol(account);
    if (match) {
      matches.push(match);
    }
  }

  if (matches.length === 0) {
    return [];
  }

  // Group by protocol
  const byProtocol = new Map<string, { displayName: string; matches: ProtocolAccountMatch[] }>();
  for (const match of matches) {
    let group = byProtocol.get(match.protocol);
    if (!group) {
      group = { displayName: match.displayName, matches: [] };
      byProtocol.set(match.protocol, group);
    }
    group.matches.push(match);
  }

  const results: ProtocolPnL[] = [];

  for (const [protocol, group] of byProtocol) {
    const revenueLines: ProtocolPnLLine[] = [];
    const expenseLines: ProtocolPnLLine[] = [];

    for (const match of group.matches) {
      // Get balance at end of period and start of period
      const endBalances = await backend.getAccountBalance(match.account.id, toDate);
      const startBalances = await backend.getAccountBalance(match.account.id, fromDate);

      // Build map of start balances by currency
      const startByCurrency = new Map<string, number>();
      for (const b of startBalances) {
        startByCurrency.set(b.currency, parseFloat(b.amount));
      }

      // Compute period activity for each currency
      for (const endBal of endBalances) {
        const endAmount = parseFloat(endBal.amount);
        const startAmount = startByCurrency.get(endBal.currency) ?? 0;
        const periodActivity = endAmount - startAmount;

        if (Math.abs(periodActivity) < 1e-8) continue;

        if (match.type === "revenue") {
          // Revenue accounts have credit (negative) balances; negate for display
          revenueLines.push({
            currency: endBal.currency,
            amount: (-periodActivity).toString(),
          });
        } else {
          // Expense accounts have debit (positive) balances
          expenseLines.push({
            currency: endBal.currency,
            amount: periodActivity.toString(),
          });
        }
      }

      // Handle currencies that existed at start but not at end (fully reversed)
      for (const [currency, startAmount] of startByCurrency) {
        if (!endBalances.some((b) => b.currency === currency)) {
          const periodActivity = 0 - startAmount;
          if (Math.abs(periodActivity) < 1e-8) continue;

          if (match.type === "revenue") {
            revenueLines.push({
              currency,
              amount: (-periodActivity).toString(),
            });
          } else {
            expenseLines.push({
              currency,
              amount: periodActivity.toString(),
            });
          }
        }
      }
    }

    const mergedRevenue = mergeLines(revenueLines);
    const mergedExpenses = mergeLines(expenseLines);

    // Skip protocols with no activity
    if (mergedRevenue.length === 0 && mergedExpenses.length === 0) continue;

    // Try to convert to base currency
    let revenueBase: number | null = null;
    let expensesBase: number | null = null;
    let allConverted = true;

    // Convert revenue
    if (mergedRevenue.length > 0) {
      revenueBase = 0;
      for (const line of mergedRevenue) {
        const amount = parseFloat(line.amount);
        if (line.currency === baseCurrency) {
          revenueBase += amount;
        } else {
          const rate = await backend.getExchangeRate(line.currency, baseCurrency, toDate);
          if (rate) {
            revenueBase += amount * parseFloat(rate);
          } else {
            allConverted = false;
          }
        }
      }
    }

    // Convert expenses
    if (mergedExpenses.length > 0) {
      expensesBase = 0;
      for (const line of mergedExpenses) {
        const amount = parseFloat(line.amount);
        if (line.currency === baseCurrency) {
          expensesBase += amount;
        } else {
          const rate = await backend.getExchangeRate(line.currency, baseCurrency, toDate);
          if (rate) {
            expensesBase += amount * parseFloat(rate);
          } else {
            allConverted = false;
          }
        }
      }
    }

    const entry: ProtocolPnL = {
      protocol,
      displayName: group.displayName,
      revenue: mergedRevenue,
      expenses: mergedExpenses,
    };

    if (revenueBase !== null) {
      entry.revenueBase = revenueBase.toString();
    }
    if (expensesBase !== null) {
      entry.expensesBase = expensesBase.toString();
    }
    if (allConverted && revenueBase !== null && expensesBase !== null) {
      entry.netIncomeBase = ((revenueBase ?? 0) - (expensesBase ?? 0)).toString();
    } else if (allConverted && revenueBase !== null) {
      entry.netIncomeBase = revenueBase.toString();
    } else if (allConverted && expensesBase !== null) {
      entry.netIncomeBase = (-expensesBase).toString();
    }

    results.push(entry);
  }

  // Sort by displayName
  results.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return results;
}
