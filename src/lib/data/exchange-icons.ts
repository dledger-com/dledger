/**
 * Static map of exchange IDs to CoinGecko exchange image URLs.
 */
export const EXCHANGE_ICONS: Record<string, string> = {
  // Original 8
  kraken: "https://assets.coingecko.com/markets/images/29/small/kraken.jpg",
  binance: "https://assets.coingecko.com/markets/images/52/small/binance.jpg",
  coinbase: "https://assets.coingecko.com/markets/images/23/small/Coinbase.jpg",
  bybit: "https://assets.coingecko.com/markets/images/698/small/bybit_spot.png",
  okx: "https://assets.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png",
  bitstamp: "https://assets.coingecko.com/markets/images/9/small/bitstamp.jpg",
  cryptocom: "https://assets.coingecko.com/markets/images/589/small/crypto_com.jpg",
  volet: "",
  // Binance clones
  "binance-tr": "https://assets.coingecko.com/markets/images/52/small/binance.jpg",
  "binance-us": "https://assets.coingecko.com/markets/images/440/small/binance_us.png",
  "binance-th": "https://assets.coingecko.com/markets/images/52/small/binance.jpg",
  tokocrypto: "https://assets.coingecko.com/markets/images/482/small/tokocrypto.png",
  // Wave 1
  bitget: "https://assets.coingecko.com/markets/images/540/small/bitget.png",
  gateio: "https://assets.coingecko.com/markets/images/60/small/gate_io.jpg",
  kucoin: "https://assets.coingecko.com/markets/images/61/small/kucoin.jpg",
  mexc: "https://assets.coingecko.com/markets/images/409/small/MEXC_logo_square.jpeg",
  htx: "https://assets.coingecko.com/markets/images/25/small/huobi.jpg",
  // Wave 2
  bingx: "https://assets.coingecko.com/markets/images/812/small/BingX_brand_logo.png",
  bitmart: "https://assets.coingecko.com/markets/images/239/small/bitmart.png",
  upbit: "https://assets.coingecko.com/markets/images/117/small/upbit.png",
  bithumb: "https://assets.coingecko.com/markets/images/11/small/bithumb.jpg",
  // Wave 3
  lbank: "https://assets.coingecko.com/markets/images/143/small/lbank.png",
  xtcom: "https://assets.coingecko.com/markets/images/404/small/xt.png",
  gemini: "https://assets.coingecko.com/markets/images/24/small/gemini.jpg",
  coinex: "https://assets.coingecko.com/markets/images/135/small/coinex.jpg",
  poloniex: "https://assets.coingecko.com/markets/images/37/small/poloniex.jpg",
  bitvavo: "https://assets.coingecko.com/markets/images/365/small/bitvavo.png",
  phemex: "https://assets.coingecko.com/markets/images/569/small/phemex.png",
  whitebit: "https://assets.coingecko.com/markets/images/418/small/whitebit.png",
};

export function getExchangeIconUrl(exchangeId: string): string | null {
  return EXCHANGE_ICONS[exchangeId] || null;
}
