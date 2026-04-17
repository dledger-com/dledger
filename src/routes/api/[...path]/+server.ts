/**
 * Server-side API proxy for production (Cloudflare Workers).
 * Replaces the Vite dev proxy: /api/{service}/... -> external API.
 *
 * In dev mode, Vite's built-in proxy handles these routes instead.
 */
import type { RequestHandler } from "./$types";

const PROXY_TARGETS: Record<string, string> = {
  // Market data
  coingecko: "https://api.coingecko.com",
  // Blockchain explorers & nodes
  etherscan: "https://api.etherscan.io",
  mempool: "https://mempool.space",
  cardano: "https://cardano-mainnet.blockfrost.io",
  tron: "https://api.trongrid.io",
  stellar: "https://horizon.stellar.org",
  cosmos: "https://lcd-cosmoshub.keplr.app",
  tezos: "https://api.tzkt.io",
  ton: "https://tonapi.io",
  near: "https://api.nearblocks.io",
  algorand: "https://mainnet-idx.algonode.cloud",
  kaspa: "https://api.kaspa.org",
  stacks: "https://api.hiro.so",
  hedera: "https://mainnet-public.mirrornode.hedera.com",
  aptos: "https://api.mainnet.aptoslabs.com",
  sui: "https://graphql.mainnet.sui.io",
  polkadot: "https://polkadot.api.subscan.io",
  bittensor: "https://bittensor.api.subscan.io",
  xrp: "https://xrplcluster.com",
  doge: "https://api.blockcypher.com",
  ltc: "https://litecoinspace.org",
  bch: "https://api.blockchair.com",
  zcash: "https://api.blockchair.com/zcash",
  hyperliquid: "https://api.hyperliquid.xyz",
  // CEX APIs
  kraken: "https://api.kraken.com",
  binance: "https://api.binance.com",
  "binance-tr": "https://api.binance.tr",
  "binance-us": "https://api.binance.us",
  "binance-th": "https://api.binance.th",
  tokocrypto: "https://api.tokocrypto.com",
  coinbase: "https://api.coinbase.com",
  bybit: "https://api.bybit.com",
  okx: "https://www.okx.com",
  bitstamp: "https://www.bitstamp.net",
  cryptocom: "https://api.crypto.com",
  volet: "https://account.volet.com",
  bitget: "https://api.bitget.com",
  gateio: "https://api.gateio.ws",
  kucoin: "https://api.kucoin.com",
  mexc: "https://api.mexc.com",
  htx: "https://api.huobi.pro",
  bingx: "https://open-api.bingx.com",
  bitmart: "https://api-cloud.bitmart.com",
  upbit: "https://api.upbit.com",
  bithumb: "https://api.bithumb.com",
  lbank: "https://api.lbank.info",
  xtcom: "https://sapi.xt.com",
  gemini: "https://api.gemini.com",
  coinex: "https://api.coinex.com",
  poloniex: "https://api.poloniex.com",
  bitvavo: "https://api.bitvavo.com",
  phemex: "https://api.phemex.com",
  whitebit: "https://whitebit.com",
  hitbtc: "https://api.hitbtc.com",
  bitpanda: "https://api.bitpanda.com",
  bitfinex: "https://api.bitfinex.com",
};

// Headers that should not be forwarded to the upstream API
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

async function handleProxy({ request, params }: { request: Request; params: { path: string } }) {
  const fullPath = params.path;
  // Extract service name: first segment (may contain hyphens like "binance-tr")
  const slashIdx = fullPath.indexOf("/");
  const service = slashIdx === -1 ? fullPath : fullPath.slice(0, slashIdx);
  const remainingPath = slashIdx === -1 ? "" : fullPath.slice(slashIdx);

  const target = PROXY_TARGETS[service];
  if (!target) {
    return new Response(JSON.stringify({ error: `Unknown service: ${service}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const targetUrl = `${target}${remainingPath}${url.search}`;

  // Forward request headers, stripping browser/proxy-specific ones
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  const resp = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined,
  });

  // Return upstream response, adding CORS headers
  const responseHeaders = new Headers(resp.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.delete("transfer-encoding");

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: responseHeaders,
  });
}

// Handle CORS preflight
const handleOptions: RequestHandler = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
    },
  });
};

export const GET: RequestHandler = handleProxy;
export const POST: RequestHandler = handleProxy;
export const PUT: RequestHandler = handleProxy;
export const DELETE: RequestHandler = handleProxy;
export const OPTIONS: RequestHandler = handleOptions;
