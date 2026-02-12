import type { TrialBalance, IncomeStatement, BalanceSheet, GainLossReport } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

export class ReportStore {
  trialBalance = $state<TrialBalance | null>(null);
  incomeStatement = $state<IncomeStatement | null>(null);
  balanceSheet = $state<BalanceSheet | null>(null);
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

  async loadIncomeStatement(fromDate: string, toDate: string) {
    this.loading = true;
    this.error = null;
    try {
      this.incomeStatement = await getBackend().incomeStatement(fromDate, toDate);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadBalanceSheet(asOf: string) {
    this.loading = true;
    this.error = null;
    try {
      this.balanceSheet = await getBackend().balanceSheet(asOf);
    } catch (e) {
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
