import type { TrialBalance, IncomeStatement, BalanceSheet, GainLossReport } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

// Module-level cache for balance sheet and income statement
let _cachedBS = $state<BalanceSheet | null>(null);
let _cachedIS = $state<IncomeStatement | null>(null);
let _bsDate: string | null = null;
let _isFrom: string | null = null;
let _isTo: string | null = null;

export class ReportStore {
  trialBalance = $state<TrialBalance | null>(null);
  incomeStatement = $state<IncomeStatement | null>(_cachedIS);
  balanceSheet = $state<BalanceSheet | null>(_cachedBS);
  gainLossReport = $state<GainLossReport | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  async loadTrialBalance(asOf: string) {
    this.loading = true;
    this.error = null;
    try {
      this.trialBalance = await getBackend().trialBalance(asOf);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadIncomeStatement(fromDate: string, toDate: string, signal?: AbortSignal) {
    if (!_cachedIS || _isFrom !== fromDate || _isTo !== toDate) this.loading = true;
    this.error = null;
    try {
      this.incomeStatement = await getBackend().incomeStatement(fromDate, toDate, signal);
      if (signal?.aborted) return;
      _cachedIS = this.incomeStatement;
      _isFrom = fromDate;
      _isTo = toDate;
    } catch (e) {
      if (signal?.aborted) return;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadBalanceSheet(asOf: string, signal?: AbortSignal) {
    if (!_cachedBS || _bsDate !== asOf) this.loading = true;
    this.error = null;
    try {
      this.balanceSheet = await getBackend().balanceSheet(asOf, signal);
      if (signal?.aborted) return;
      _cachedBS = this.balanceSheet;
      _bsDate = asOf;
    } catch (e) {
      if (signal?.aborted) return;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadGainLossReport(fromDate: string, toDate: string) {
    this.loading = true;
    this.error = null;
    try {
      this.gainLossReport = await getBackend().gainLossReport(fromDate, toDate);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }
}
