import type { ExchangeId, CexAdapter } from "./types.js";
import { KrakenAdapter } from "./kraken.js";
import { BinanceAdapter } from "./binance.js";
import { BybitAdapter } from "./bybit.js";
import { CoinbaseAdapter } from "./coinbase.js";
import { CryptocomAdapter } from "./cryptocom.js";
import { BitstampAdapter } from "./bitstamp.js";
import { OkxAdapter } from "./okx.js";
import { VoletAdapter } from "./volet.js";

const ADAPTERS: Partial<Record<ExchangeId, () => CexAdapter>> = {
  kraken: () => new KrakenAdapter(),
  binance: () => new BinanceAdapter(),
  bybit: () => new BybitAdapter(),
  coinbase: () => new CoinbaseAdapter(),
  cryptocom: () => new CryptocomAdapter(),
  bitstamp: () => new BitstampAdapter(),
  okx: () => new OkxAdapter(),
  volet: () => new VoletAdapter(),
};

export function getCexAdapter(id: ExchangeId): CexAdapter {
  const factory = ADAPTERS[id];
  if (!factory) throw new Error(`Unknown exchange: ${id}`);
  return factory();
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
