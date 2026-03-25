import type { CexAdapter } from "../../cex/types.js";
import { KrakenAdapter } from "../../cex/kraken.js";
import { BinanceAdapter } from "../../cex/binance.js";
import { BybitAdapter } from "../../cex/bybit.js";
import { CoinbaseAdapter } from "../../cex/coinbase.js";
import { CryptocomAdapter } from "../../cex/cryptocom.js";
import { BitstampAdapter } from "../../cex/bitstamp.js";
import { OkxAdapter } from "../../cex/okx.js";
import { VoletAdapter } from "../../cex/volet.js";
import { BitgetAdapter } from "../../cex/bitget.js";
import { GateioAdapter } from "../../cex/gateio.js";
import { KucoinAdapter } from "../../cex/kucoin.js";
import { MexcAdapter } from "../../cex/mexc.js";
import { HtxAdapter } from "../../cex/htx.js";
import { BingxAdapter } from "../../cex/bingx.js";
import { BitmartAdapter } from "../../cex/bitmart.js";
import { UpbitAdapter } from "../../cex/upbit.js";
import { BithumbAdapter } from "../../cex/bithumb.js";
import { LbankAdapter } from "../../cex/lbank.js";
import { XtcomAdapter } from "../../cex/xtcom.js";
import { GeminiAdapter } from "../../cex/gemini.js";
import { CoinexAdapter } from "../../cex/coinex.js";
import { PoloniexAdapter } from "../../cex/poloniex-cex.js";
import { BitvavoAdapter } from "../../cex/bitvavo.js";
import { PhemexAdapter } from "../../cex/phemex.js";
import { WhitebitAdapter } from "../../cex/whitebit.js";

export const builtinCexAdapters: CexAdapter[] = [
  new KrakenAdapter(),
  new BinanceAdapter(),
  new BybitAdapter(),
  new CoinbaseAdapter(),
  new CryptocomAdapter(),
  new BitstampAdapter(),
  new OkxAdapter(),
  new VoletAdapter(),
  // Binance regional clones
  new BinanceAdapter({
    exchangeId: "binance-tr", exchangeName: "Binance TR",
    baseUrl: "https://api.binance.tr", proxyPrefix: "/api/binance-tr",
  }),
  new BinanceAdapter({
    exchangeId: "binance-us", exchangeName: "Binance.US",
    baseUrl: "https://api.binance.us", proxyPrefix: "/api/binance-us",
  }),
  new BinanceAdapter({
    exchangeId: "binance-th", exchangeName: "Binance TH",
    baseUrl: "https://api.binance.th", proxyPrefix: "/api/binance-th",
  }),
  new BinanceAdapter({
    exchangeId: "tokocrypto", exchangeName: "Tokocrypto",
    baseUrl: "https://api.tokocrypto.com", proxyPrefix: "/api/tokocrypto",
  }),
  // Wave 1
  new BitgetAdapter(),
  new GateioAdapter(),
  new KucoinAdapter(),
  new MexcAdapter(),
  new HtxAdapter(),
  // Wave 2
  new BingxAdapter(),
  new BitmartAdapter(),
  new UpbitAdapter(),
  new BithumbAdapter(),
  // Wave 3
  new LbankAdapter(),
  new XtcomAdapter(),
  new GeminiAdapter(),
  new CoinexAdapter(),
  new PoloniexAdapter(),
  new BitvavoAdapter(),
  new PhemexAdapter(),
  new WhitebitAdapter(),
];
