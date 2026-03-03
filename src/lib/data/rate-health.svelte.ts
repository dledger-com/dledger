/**
 * Reactive rate health store — tracks the status of automatic exchange rate syncing.
 */

import type { AutoBackfillResult } from "$lib/exchange-rate-historical.js";

export interface RateHealthState {
  status: "ok" | "missing" | "syncing" | "unknown";
  /** Currencies with gaps that couldn't be filled (not hidden, rate_source = "none") */
  missingCurrencies: string[];
  lastSyncResult?: AutoBackfillResult;
  lastSyncTime?: string;
}

export let rateHealth = $state<RateHealthState>({
  status: "unknown",
  missingCurrencies: [],
});

export function setRateHealthSyncing(): void {
  rateHealth.status = "syncing";
}

export function updateRateHealth(
  result: AutoBackfillResult,
  failedNonHidden: string[],
): void {
  rateHealth.lastSyncResult = result;
  rateHealth.lastSyncTime = new Date().toISOString();
  rateHealth.missingCurrencies = failedNonHidden;
  rateHealth.status = failedNonHidden.length > 0 ? "missing" : "ok";
}
