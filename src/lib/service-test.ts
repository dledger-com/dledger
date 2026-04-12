export type TestResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp;
}

export async function testFrankfurter(): Promise<TestResult> {
  try {
    const resp = await safeFetch(
      "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD",
    );
    const data = await resp.json();
    const rate = data?.rates?.USD;
    return rate
      ? { ok: true, detail: `EUR/USD: ${rate}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testFinnhub(apiKey: string): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const resp = await safeFetch(
      `https://finnhub.io/api/v1/quote?symbol=AAPL`,
      { headers: { "X-Finnhub-Token": apiKey } },
    );
    const data = await resp.json();
    if (data?.error) return { ok: false, error: data.error };
    const price = data?.c;
    return price != null
      ? { ok: true, detail: `AAPL: $${price}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testCoinGecko(apiKey: string, pro?: boolean): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const url = pro
      ? `https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`
      : `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`;
    const headers: Record<string, string> = pro
      ? { "x-cg-pro-api-key": apiKey }
      : { "x-cg-demo-api-key": apiKey };
    const resp = await safeFetch(url, { headers });
    const data = await resp.json();
    const price = data?.bitcoin?.usd;
    return price != null
      ? { ok: true, detail: `BTC: $${Number(price).toLocaleString()}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface CoinGeckoKeyInfo {
  plan: string;
  rateLimit: number;
  monthlyCredit: number;
  monthlyUsed: number;
  monthlyRemaining: number;
}

export async function getCoinGeckoKeyInfo(apiKey: string, pro?: boolean): Promise<CoinGeckoKeyInfo | null> {
  if (!apiKey) return null;
  try {
    const url = pro
      ? "https://pro-api.coingecko.com/api/v3/key"
      : "https://api.coingecko.com/api/v3/key";
    const headers: Record<string, string> = pro
      ? { "x-cg-pro-api-key": apiKey }
      : { "x-cg-demo-api-key": apiKey };
    const resp = await safeFetch(url, { headers });
    const data = await resp.json();
    return {
      plan: data.plan ?? "Unknown",
      rateLimit: data.rate_limit_request_per_minute ?? 0,
      monthlyCredit: data.monthly_call_credit ?? 0,
      monthlyUsed: data.current_total_monthly_calls ?? 0,
      monthlyRemaining: data.current_remaining_monthly_calls ?? 0,
    };
  } catch { return null; }
}

export async function testCryptoCompare(apiKey: string): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const resp = await safeFetch(
      `https://min-api.cryptocompare.com/data/pricemulti?fsyms=BTC&tsyms=USD`,
      { headers: { authorization: `Apikey ${apiKey}` } },
    );
    const data = await resp.json();
    if (data?.Response === "Error") return { ok: false, error: data.Message ?? "API error" };
    const price = data?.BTC?.USD;
    return price != null
      ? { ok: true, detail: `BTC: $${Number(price).toLocaleString()}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testDefiLlama(): Promise<TestResult> {
  try {
    const resp = await safeFetch(
      "https://coins.llama.fi/prices/current/coingecko:bitcoin",
    );
    const data = await resp.json();
    const price = data?.coins?.["coingecko:bitcoin"]?.price;
    return price != null
      ? { ok: true, detail: `BTC: $${Number(price).toLocaleString()}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testBinance(): Promise<TestResult> {
  try {
    const resp = await safeFetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    );
    const data = await resp.json();
    const price = data?.price;
    return price != null
      ? { ok: true, detail: `BTC: $${Number(price).toLocaleString()}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testEtherscan(apiKey: string): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const resp = await safeFetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice&apikey=${encodeURIComponent(apiKey)}`,
    );
    const data = await resp.json();
    if (data?.status === "0") return { ok: false, error: data.result ?? "API error" };
    const price = data?.result?.ethusd;
    return price != null
      ? { ok: true, detail: `ETH: $${Number(price).toLocaleString()}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testRoutescan(apiKey?: string): Promise<TestResult> {
  try {
    const url = apiKey
      ? `https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=proxy&action=eth_blockNumber&apikey=${encodeURIComponent(apiKey)}`
      : "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=proxy&action=eth_blockNumber";
    const resp = await safeFetch(url);
    const data = await resp.json();
    if (data?.error) return { ok: false, error: data.error.message ?? "API error" };
    const hex = data?.result;
    if (typeof hex === "string" && hex.startsWith("0x")) {
      const blockNum = parseInt(hex, 16);
      return { ok: true, detail: `Block #${blockNum.toLocaleString()}` };
    }
    return { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Aave v3 subgraph on The Graph decentralized network
const AAVE_V3_SUBGRAPH_ID = "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";

export async function testTheGraph(apiKey: string): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const resp = await safeFetch(
      `https://gateway.thegraph.com/api/${encodeURIComponent(apiKey)}/subgraphs/id/${AAVE_V3_SUBGRAPH_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
      },
    );
    const data = await resp.json();
    if (data?.errors?.length) return { ok: false, error: data.errors[0].message };
    const block = data?.data?._meta?.block?.number;
    return block != null
      ? { ok: true, detail: `Aave v3 block: ${block}` }
      : { ok: false, error: "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testHelius(apiKey: string): Promise<TestResult> {
  if (!apiKey) return { ok: false, error: "API key required" };
  try {
    const resp = await safeFetch(
      `https://api.helius.xyz/v0/addresses/11111111111111111111111111111112/balances?api-key=${encodeURIComponent(apiKey)}`,
    );
    const data = await resp.json();
    if (data?.nativeBalance != null) return { ok: true, detail: "Connected" };
    return { ok: false, error: data?.error ?? "Unexpected response format" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testDprice(
  healthFn: () => Promise<{ assets: number; prices: number }>,
): Promise<TestResult> {
  try {
    const health = await healthFn();
    return {
      ok: true,
      detail: `${health.assets.toLocaleString()} assets, ${health.prices.toLocaleString()} prices`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
