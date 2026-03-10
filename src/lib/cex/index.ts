import type { ExchangeId, CexAdapter } from "./types.js";
import { getPluginManager } from "../plugins/manager.js";

export function getCexAdapter(id: ExchangeId): CexAdapter {
  return getPluginManager().cexAdapters.get(id);
}

export { syncCexAccount, normalizeTxid } from "./pipeline.js";
export { KrakenAdapter } from "./kraken.js";
export { BinanceAdapter } from "./binance.js";
export { BybitAdapter } from "./bybit.js";
export { CoinbaseAdapter } from "./coinbase.js";
export { CryptocomAdapter } from "./cryptocom.js";
export { BitstampAdapter } from "./bitstamp.js";
export { OkxAdapter } from "./okx.js";
export { VoletAdapter } from "./volet.js";
export { retroactiveConsolidate } from "./consolidate.js";
export type { ConsolidationResult, ConsolidationOptions } from "./consolidate.js";
export type { ExchangeId, ExchangeAccount, CexAdapter, CexLedgerRecord, CexSyncResult } from "./types.js";
