import type { CexAdapter } from "../../cex/types.js";
import { KrakenAdapter } from "../../cex/kraken.js";
import { BinanceAdapter } from "../../cex/binance.js";
import { BybitAdapter } from "../../cex/bybit.js";
import { CoinbaseAdapter } from "../../cex/coinbase.js";
import { CryptocomAdapter } from "../../cex/cryptocom.js";
import { BitstampAdapter } from "../../cex/bitstamp.js";
import { OkxAdapter } from "../../cex/okx.js";
import { VoletAdapter } from "../../cex/volet.js";

export const builtinCexAdapters: CexAdapter[] = [
  new KrakenAdapter(),
  new BinanceAdapter(),
  new BybitAdapter(),
  new CoinbaseAdapter(),
  new CryptocomAdapter(),
  new BitstampAdapter(),
  new OkxAdapter(),
  new VoletAdapter(),
];
