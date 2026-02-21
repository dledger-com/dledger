/**
 * Aave Protocol Subgraph client for enrichment data.
 * Fetches historical interest rates, asset prices, and liquidation details
 * from Aave's indexed subgraphs via The Graph Network.
 */

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
    debtToCover
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
    debtToCover
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
    debtToCover: string;
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
        debt_amount: liq.debtToCover,
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
  if (!apiKey) return null;

  const chain = AAVE_SUBGRAPHS[chainId];
  if (!chain) return null;

  const subgraphId = isV2 ? chain.v2 : chain.v3;
  if (!subgraphId) {
    // Fall back to the other version if available
    const fallbackId = isV2 ? chain.v3 : chain.v2;
    if (!fallbackId) return null;
    return fetchFromSubgraph(apiKey, fallbackId, txHash, !isV2);
  }

  return fetchFromSubgraph(apiKey, subgraphId, txHash, isV2);
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
