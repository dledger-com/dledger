/**
 * Aave Protocol Subgraph client for enrichment data.
 * Fetches historical interest rates, asset prices, and liquidation details
 * from Aave's indexed subgraphs via The Graph Network.
 */

/** Module-level cache: tx hash → result (null = queried but no events) */
const cache = new Map<string, AaveSubgraphResult | null>();

export function clearAaveSubgraphCache(): void {
  cache.clear();
}

/** Subgraph deployment IDs per chain (v2 and v3) */
export const AAVE_SUBGRAPHS: Record<number, { v2?: string; v3?: string }> = {
  1: {
    v2: "8wR23o1zkS4gpLqLNU4kG3JHYVucqGyopL5utGxP2q1N",
    v3: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
  },
  42161: { v3: "DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B" },
  10: { v3: "DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb" },
  137: {
    v2: "H1Et77RZh3XEf27vkAmJyzgCME2RSFLtDS2f4PPW6CGp",
    v3: "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211",
  },
  8453: { v3: "GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF" },
};

/** Convert Aave RAY-denominated rate (1e27) to annualized APY decimal */
export function rayToApy(rayRate: string): string {
  const SECONDS_PER_YEAR = 31536000;
  const rate = Number(rayRate) / 1e27;
  if (rate === 0) return "0";
  const apy = Math.pow(1 + rate / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
  return apy.toString();
}

export interface AaveLiquidationData {
  liquidator: string;
  collateral_asset: string;
  collateral_amount: string;
  collateral_price_usd: string;
  debt_asset: string;
  debt_amount: string;
  debt_price_usd: string;
}

export interface AaveSubgraphResult {
  supply_apy: string;
  borrow_apy: string;
  asset_price_usd: string;
  utilization_rate: string;
  total_liquidity: string;
  liquidation?: AaveLiquidationData;
}

const RESERVE_FIELDS = `
  reserve {
    symbol
    liquidityRate
    variableBorrowRate
    totalATokenSupply
    availableLiquidity
  }
`;

function buildV2Query(txHash: string): string {
  return `{
  deposits(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  borrows(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  redeemUnderlyings(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  repays(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  liquidationCalls(where: { id_contains: "${txHash}" }, first: 5) {
    collateralAmount
    principalAmount
    liquidator
    collateralAssetPriceUSD: collateralAssetPriceUSD
    borrowAssetPriceUSD: borrowAssetPriceUSD
    collateralReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
    principalReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
  }
}`;
}

function buildV3Query(txHash: string): string {
  return `{
  supplies(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  borrows(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  redeemUnderlyings(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  repays(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }
  liquidationCalls(where: { id_contains: "${txHash}" }, first: 5) {
    collateralAmount
    principalAmount
    liquidator
    collateralAssetPriceUSD: collateralAssetPriceUSD
    borrowAssetPriceUSD: borrowAssetPriceUSD
    collateralReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
    principalReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
  }
}`;
}

interface ReserveData {
  symbol: string;
  liquidityRate: string;
  variableBorrowRate: string;
  totalATokenSupply: string;
  availableLiquidity: string;
}

function computeUtilization(reserve: ReserveData): string {
  const total = Number(reserve.totalATokenSupply);
  const available = Number(reserve.availableLiquidity);
  if (total === 0) return "0";
  return ((total - available) / total).toString();
}

function extractFromEvents(data: Record<string, unknown[]>): AaveSubgraphResult | null {
  // Check liquidations first
  const liquidations = (data.liquidationCalls ?? []) as Array<{
    collateralAmount: string;
    principalAmount: string;
    liquidator: string;
    collateralAssetPriceUSD: string;
    borrowAssetPriceUSD: string;
    collateralReserve: ReserveData;
    principalReserve: ReserveData;
  }>;
  if (liquidations.length > 0) {
    const liq = liquidations[0];
    return {
      supply_apy: rayToApy(liq.collateralReserve.liquidityRate),
      borrow_apy: rayToApy(liq.principalReserve.variableBorrowRate),
      asset_price_usd: liq.collateralAssetPriceUSD ?? "0",
      utilization_rate: computeUtilization(liq.collateralReserve),
      total_liquidity: liq.collateralReserve.totalATokenSupply,
      liquidation: {
        liquidator: liq.liquidator,
        collateral_asset: liq.collateralReserve.symbol,
        collateral_amount: liq.collateralAmount,
        collateral_price_usd: liq.collateralAssetPriceUSD ?? "0",
        debt_asset: liq.principalReserve.symbol,
        debt_amount: liq.principalAmount,
        debt_price_usd: liq.borrowAssetPriceUSD ?? "0",
      },
    };
  }

  // Check regular events: deposits/supplies, borrows, redeemUnderlyings, repays
  const eventTypes = ["deposits", "supplies", "borrows", "redeemUnderlyings", "repays"];
  for (const eventType of eventTypes) {
    const events = (data[eventType] ?? []) as Array<{
      amount: string;
      assetPriceUSD: string;
      reserve: ReserveData;
    }>;
    if (events.length > 0) {
      const event = events[0];
      return {
        supply_apy: rayToApy(event.reserve.liquidityRate),
        borrow_apy: rayToApy(event.reserve.variableBorrowRate),
        asset_price_usd: event.assetPriceUSD ?? "0",
        utilization_rate: computeUtilization(event.reserve),
        total_liquidity: event.reserve.totalATokenSupply,
      };
    }
  }

  return null;
}

/**
 * Fetch enrichment data from Aave protocol subgraphs for a given transaction.
 * Returns historical rates, prices, and liquidation details when available.
 */
export async function fetchAaveSubgraphData(
  apiKey: string,
  chainId: number,
  txHash: string,
  isV2: boolean,
): Promise<AaveSubgraphResult | null> {
  const cacheKey = txHash.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  if (!apiKey) return null;

  const chain = AAVE_SUBGRAPHS[chainId];
  if (!chain) return null;

  const subgraphId = isV2 ? chain.v2 : chain.v3;
  if (!subgraphId) {
    // Fall back to the other version if available
    const fallbackId = isV2 ? chain.v3 : chain.v2;
    if (!fallbackId) return null;
    const result = await fetchFromSubgraph(apiKey, fallbackId, txHash, !isV2);
    cache.set(cacheKey, result);
    return result;
  }

  const result = await fetchFromSubgraph(apiKey, subgraphId, txHash, isV2);
  cache.set(cacheKey, result);
  return result;
}

async function fetchFromSubgraph(
  apiKey: string,
  subgraphId: string,
  txHash: string,
  isV2: boolean,
): Promise<AaveSubgraphResult | null> {
  const query = isV2 ? buildV2Query(txHash) : buildV3Query(txHash);

  const resp = await fetch(
    `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  if (!resp.ok) return null;

  const json = await resp.json();
  const data = json?.data;
  if (!data) return null;

  return extractFromEvents(data);
}

/** Event type names used in V2 vs V3 queries */
const V2_EVENT_TYPES = ["deposits", "borrows", "redeemUnderlyings", "repays", "liquidationCalls"] as const;
const V3_EVENT_TYPES = ["supplies", "borrows", "redeemUnderlyings", "repays", "liquidationCalls"] as const;

function buildBatchFields(prefix: string, txHash: string, isV2: boolean): string {
  const eventTypes = isV2 ? V2_EVENT_TYPES : V3_EVENT_TYPES;
  const supplyType = isV2 ? "deposits" : "supplies";
  const lines: string[] = [];

  for (const eventType of eventTypes) {
    const alias = `${prefix}_${eventType}`;
    if (eventType === "liquidationCalls") {
      lines.push(`  ${alias}: ${eventType}(where: { id_contains: "${txHash}" }, first: 5) {
    collateralAmount
    principalAmount
    liquidator
    collateralAssetPriceUSD: collateralAssetPriceUSD
    borrowAssetPriceUSD: borrowAssetPriceUSD
    collateralReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
    principalReserve { symbol liquidityRate variableBorrowRate totalATokenSupply availableLiquidity }
  }`);
    } else {
      lines.push(`  ${alias}: ${eventType}(where: { id_contains: "${txHash}" }, first: 5) {
    amount
    assetPriceUSD
    ${RESERVE_FIELDS}
  }`);
    }
  }
  return lines.join("\n");
}

const BATCH_SIZE = 20;

/**
 * Pre-fetch enrichment data for multiple Aave transactions in batched
 * GraphQL requests. Results are stored in the module cache so that
 * subsequent `fetchAaveSubgraphData()` calls return instantly.
 */
export async function prefetchAaveSubgraphBatch(
  apiKey: string,
  chainId: number,
  entries: { hash: string; isV2: boolean }[],
): Promise<void> {
  if (!apiKey) return;
  const chain = AAVE_SUBGRAPHS[chainId];
  if (!chain) return;

  // Filter out already-cached entries
  const uncached = entries.filter((e) => !cache.has(e.hash.toLowerCase()));
  if (uncached.length === 0) return;

  // Group by version
  const v2Entries = uncached.filter((e) => e.isV2);
  const v3Entries = uncached.filter((e) => !e.isV2);

  for (const [isV2, group] of [[true, v2Entries], [false, v3Entries]] as const) {
    if (group.length === 0) continue;

    const subgraphId = isV2 ? chain.v2 : chain.v3;
    // Fall back to the other version if primary not available
    const effectiveId = subgraphId ?? (isV2 ? chain.v3 : chain.v2);
    if (!effectiveId) {
      // No subgraph for this chain+version — mark all as null
      for (const entry of group) {
        cache.set(entry.hash.toLowerCase(), null);
      }
      continue;
    }
    const effectiveIsV2 = subgraphId ? isV2 : !isV2;

    // Process in batches
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const queryParts: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        queryParts.push(buildBatchFields(`tx${j}`, batch[j].hash, effectiveIsV2));
      }
      const query = `{\n${queryParts.join("\n")}\n}`;

      try {
        const resp = await fetch(
          `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${effectiveId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          },
        );
        if (!resp.ok) {
          // Mark batch as null so we don't retry
          for (const entry of batch) {
            cache.set(entry.hash.toLowerCase(), null);
          }
          continue;
        }

        const json = await resp.json();
        const data = json?.data;
        if (!data) {
          for (const entry of batch) {
            cache.set(entry.hash.toLowerCase(), null);
          }
          continue;
        }

        // Parse aliased response back into per-tx event maps
        const eventTypes = effectiveIsV2 ? V2_EVENT_TYPES : V3_EVENT_TYPES;
        for (let j = 0; j < batch.length; j++) {
          const prefix = `tx${j}`;
          const txData: Record<string, unknown[]> = {};
          for (const eventType of eventTypes) {
            txData[eventType] = data[`${prefix}_${eventType}`] ?? [];
          }
          const result = extractFromEvents(txData);
          cache.set(batch[j].hash.toLowerCase(), result);
        }
      } catch {
        // Network error — mark batch as null
        for (const entry of batch) {
          cache.set(entry.hash.toLowerCase(), null);
        }
      }
    }
  }
}
