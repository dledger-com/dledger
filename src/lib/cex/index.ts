import type { ExchangeId, CexAdapter } from "./types.js";
import { KrakenAdapter } from "./kraken.js";

const ADAPTERS: Record<ExchangeId, () => CexAdapter> = {
  kraken: () => new KrakenAdapter(),
};

export function getCexAdapter(id: ExchangeId): CexAdapter {
  const factory = ADAPTERS[id];
  if (!factory) throw new Error(`Unknown exchange: ${id}`);
  return factory();
}

export { syncCexAccount, normalizeTxid } from "./pipeline.js";
export { KrakenAdapter } from "./kraken.js";
export { retroactiveConsolidate } from "./consolidate.js";
export type { ConsolidationResult, ConsolidationOptions } from "./consolidate.js";
export type { ExchangeId, ExchangeAccount, CexAdapter, CexLedgerRecord, CexSyncResult } from "./types.js";
