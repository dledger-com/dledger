import type { TrialBalance, IncomeStatement, BalanceSheet, GainLossReport } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";
import { taskQueue } from "$lib/task-queue.svelte.js";

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

  enqueueTrialBalance(asOf: string): Promise<void> {
    this.loading = true;
    this.error = null;
    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:trial-balance:${asOf}`,
        label: "Trial Balance",
        description: `As of ${asOf}`,
        run: async (ctx) => {
          try {
            const result = await getBackend().trialBalance(asOf);
            if (ctx.signal.aborted) return;
            this.trialBalance = result;
          } catch (e) {
            if (ctx.signal.aborted) return;
            this.error = e instanceof Error ? e.message : String(e);
          } finally {
            this.loading = false;
            resolve();
          }
          return { summary: "Trial balance generated" };
        },
      });
      if (id === null) {
        this.loading = false;
        resolve();
      }
    });
  }

  enqueueIncomeStatement(fromDate: string, toDate: string): Promise<void> {
    if (!_cachedIS || _isFrom !== fromDate || _isTo !== toDate) this.loading = true;
    this.error = null;
    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:income-statement:${fromDate}:${toDate}`,
        label: "Income Statement",
        description: `${fromDate} to ${toDate}`,
        run: async (ctx) => {
          try {
            const result = await getBackend().incomeStatement(fromDate, toDate, ctx.signal);
            if (ctx.signal.aborted) return;
            this.incomeStatement = result;
            _cachedIS = result;
            _isFrom = fromDate;
            _isTo = toDate;
          } catch (e) {
            if (ctx.signal.aborted) return;
            this.error = e instanceof Error ? e.message : String(e);
          } finally {
            this.loading = false;
            resolve();
          }
          return { summary: "Income statement generated" };
        },
      });
      if (id === null) {
        this.loading = false;
        resolve();
      }
    });
  }

  enqueueBalanceSheet(asOf: string): Promise<void> {
    if (!_cachedBS || _bsDate !== asOf) this.loading = true;
    this.error = null;
    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:balance-sheet:${asOf}`,
        label: "Balance Sheet",
        description: `As of ${asOf}`,
        run: async (ctx) => {
          try {
            const result = await getBackend().balanceSheet(asOf, ctx.signal);
            if (ctx.signal.aborted) return;
            this.balanceSheet = result;
            _cachedBS = result;
            _bsDate = asOf;
          } catch (e) {
            if (ctx.signal.aborted) return;
            this.error = e instanceof Error ? e.message : String(e);
          } finally {
            this.loading = false;
            resolve();
          }
          return { summary: "Balance sheet generated" };
        },
      });
      if (id === null) {
        this.loading = false;
        resolve();
      }
    });
  }

  enqueueGainLossReport(fromDate: string, toDate: string): Promise<void> {
    this.loading = true;
    this.error = null;
    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:gain-loss:${fromDate}:${toDate}`,
        label: "Gain/Loss Report",
        description: `${fromDate} to ${toDate}`,
        run: async (ctx) => {
          try {
            const result = await getBackend().gainLossReport(fromDate, toDate);
            if (ctx.signal.aborted) return;
            this.gainLossReport = result;
          } catch (e) {
            if (ctx.signal.aborted) return;
            this.error = e instanceof Error ? e.message : String(e);
          } finally {
            this.loading = false;
            resolve();
          }
          return { summary: "Gain/loss report generated" };
        },
      });
      if (id === null) {
        this.loading = false;
        resolve();
      }
    });
  }
}
