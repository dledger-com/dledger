import type { Backend } from "$lib/backend.js";
import type { GainLossLine } from "$lib/types/index.js";

export interface TaxSummaryOptions {
  fromDate: string;
  toDate: string;
  holdingPeriodDays: number; // default 365
  baseCurrency: string;
}

export interface TaxSummary {
  from_date: string;
  to_date: string;
  holding_period_days: number;
  short_term_gains: string;
  short_term_losses: string;
  long_term_gains: string;
  long_term_losses: string;
  total_realized: string;
  total_unrealized: string;
  income_by_account: { account_name: string; currency: string; amount: string }[];
  gain_loss_lines: (GainLossLine & { is_long_term: boolean })[];
}

export function computeTaxYearDates(fiscalYearStart: string, year?: number): { from: string; to: string } {
  // fiscalYearStart is "MM-DD" format (e.g. "01-01")
  // If year not provided, use current year
  // Returns { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } spanning one fiscal year
  const y = year ?? new Date().getFullYear();
  const from = `${y}-${fiscalYearStart}`;
  const [mm, dd] = fiscalYearStart.split("-").map(Number);
  // to = one day before the next fiscal year start
  const nextStart = new Date(y + 1, mm - 1, dd);
  nextStart.setDate(nextStart.getDate() - 1);
  const toY = nextStart.getFullYear();
  const toM = String(nextStart.getMonth() + 1).padStart(2, "0");
  const toD = String(nextStart.getDate()).padStart(2, "0");
  const to = `${toY}-${toM}-${toD}`;
  return { from, to };
}

export async function computeTaxSummary(backend: Backend, opts: TaxSummaryOptions): Promise<TaxSummary> {
  // 1. Get gain/loss report from backend
  const glReport = await backend.gainLossReport(opts.fromDate, opts.toDate);

  // 2. Classify each line as short-term or long-term based on holding period
  let stGains = 0, stLosses = 0, ltGains = 0, ltLosses = 0;
  const classifiedLines: (GainLossLine & { is_long_term: boolean })[] = [];

  for (const line of glReport.lines) {
    const acquired = new Date(line.acquired_date);
    const disposed = new Date(line.disposed_date);
    const holdingDays = Math.floor((disposed.getTime() - acquired.getTime()) / (1000 * 60 * 60 * 24));
    const isLongTerm = holdingDays >= opts.holdingPeriodDays;
    const gl = parseFloat(line.gain_loss);

    if (isLongTerm) {
      if (gl >= 0) ltGains += gl; else ltLosses += gl;
    } else {
      if (gl >= 0) stGains += gl; else stLosses += gl;
    }

    classifiedLines.push({ ...line, is_long_term: isLongTerm });
  }

  // 3. Get income from income statement
  const incomeStmt = await backend.incomeStatement(opts.fromDate, opts.toDate);
  const incomeByAccount: { account_name: string; currency: string; amount: string }[] = [];
  for (const line of incomeStmt.revenue.lines) {
    for (const bal of line.balances) {
      incomeByAccount.push({
        account_name: line.account_name,
        currency: bal.currency,
        amount: Math.abs(parseFloat(bal.amount)).toString(),
      });
    }
  }

  // 4. Get unrealized totals
  let totalUnrealized = "0";
  try {
    const { computeUnrealizedGainLoss } = await import("./unrealized-gains.js");
    const result = await computeUnrealizedGainLoss(backend, {
      baseCurrency: opts.baseCurrency,
      asOfDate: opts.toDate,
    });
    totalUnrealized = result.report.total_unrealized;
  } catch {
    // unrealized computation may fail if no exchange rates available
  }

  const totalRealized = (stGains + stLosses + ltGains + ltLosses).toString();

  return {
    from_date: opts.fromDate,
    to_date: opts.toDate,
    holding_period_days: opts.holdingPeriodDays,
    short_term_gains: stGains.toString(),
    short_term_losses: stLosses.toString(),
    long_term_gains: ltGains.toString(),
    long_term_losses: ltLosses.toString(),
    total_realized: totalRealized,
    total_unrealized: totalUnrealized,
    income_by_account: incomeByAccount,
    gain_loss_lines: classifiedLines,
  };
}
