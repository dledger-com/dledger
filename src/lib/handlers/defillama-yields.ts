// Shared DefiLlama yields cache for Compound and Maker/Spark enrichment.
// The /pools endpoint returns 10+ MB of data, so caching per sync session is critical.

let cachedPools: DefiLlamaPool[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface DefiLlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  apyBase: number | null;
  apyReward: number | null;
  apyBaseBorrow: number | null;
  apyRewardBorrow: number | null;
  tvlUsd: number | null;
}

const CHAIN_ID_TO_NAME: Record<number, string> = {
  1: "Ethereum",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
};

export async function getDefiLlamaPools(): Promise<DefiLlamaPool[]> {
  const now = Date.now();
  if (cachedPools && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPools;
  }

  const resp = await fetch("https://yields.llama.fi/pools");
  if (!resp.ok) {
    throw new Error(`DefiLlama yields API returned ${resp.status}`);
  }

  const json = await resp.json();
  const pools: DefiLlamaPool[] = json?.data ?? [];
  cachedPools = pools;
  cacheTimestamp = now;
  return pools;
}

export interface DefiLlamaYield {
  apyBase: string;
  apyBaseBorrow: string;
}

export function findPool(
  pools: DefiLlamaPool[],
  project: string,
  symbol: string,
  chainId: number,
): DefiLlamaYield | null {
  const chain = CHAIN_ID_TO_NAME[chainId] ?? "Ethereum";
  const target = symbol.toUpperCase();

  const match = pools.find(
    (p) =>
      p.project === project &&
      p.chain === chain &&
      p.symbol.toUpperCase().includes(target),
  );
  if (!match) return null;

  return {
    apyBase: match.apyBase != null ? (match.apyBase / 100).toString() : "",
    apyBaseBorrow: match.apyBaseBorrow != null ? (match.apyBaseBorrow / 100).toString() : "",
  };
}
