import type { AccountType } from "./account.js";

export interface CurrencyBalance {
  currency: string;
  amount: string;
}

export interface TrialBalanceLine {
  account_id: string;
  account_name: string;
  account_type: AccountType;
  balances: CurrencyBalance[];
}

export interface TrialBalance {
  as_of: string;
  lines: TrialBalanceLine[];
  total_debits: CurrencyBalance[];
  total_credits: CurrencyBalance[];
}

export interface ReportSection {
  title: string;
  account_type: AccountType;
  lines: TrialBalanceLine[];
  totals: CurrencyBalance[];
}

export interface IncomeStatement {
  from_date: string;
  to_date: string;
  revenue: ReportSection;
  expenses: ReportSection;
  net_income: CurrencyBalance[];
}

export interface BalanceSheet {
  as_of: string;
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
}

export interface GainLossLine {
  lot_id: string;
  currency: string;
  acquired_date: string;
  disposed_date: string;
  quantity: string;
  cost_basis: string;
  proceeds: string;
  gain_loss: string;
}

export interface GainLossReport {
  from_date: string;
  to_date: string;
  lines: GainLossLine[];
  total_gain_loss: string;
}
