import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "./types.js";
import { timestampToDate } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  remapCounterpartyAccounts,
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  type TokenFlow,
} from "./item-builder.js";
import { CURVE, ZERO_ADDRESS } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";
import { renderDescription } from "../types/description-data.js";

// ---- Token detection ----

function isCurveLP(symbol: string): boolean {
  return /crv/i.test(symbol);
}

function isGaugeToken(symbol: string): boolean {
  return symbol.endsWith("-gauge");
}

// ---- Action classification ----

type CurveAction =
  | "SWAP"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "CLAIM_CRV"
  | "STAKE_GAUGE"
  | "UNSTAKE_GAUGE"
  | "UNKNOWN";

function classifyAction(flows: TokenFlow[], group: TxHashGroup): CurveAction {
  const lpMinted = flows.some((f) => f.direction === "in" && f.isMint && isCurveLP(f.symbol));
  const lpBurned = flows.some((f) => f.direction === "out" && f.isBurn && isCurveLP(f.symbol));
  const gaugeMinted = flows.some((f) => f.direction === "in" && f.isMint && isGaugeToken(f.symbol));
  const gaugeBurned = flows.some((f) => f.direction === "out" && f.isBurn && isGaugeToken(f.symbol));
  const lpOutflow = flows.some((f) => f.direction === "out" && isCurveLP(f.symbol));
  const lpInflow = flows.some((f) => f.direction === "in" && isCurveLP(f.symbol));

  // CRV claim: inflow from Minter, no outflows from user
  const crvFromMinter = flows.some(
    (f) => f.direction === "in" && f.from === CURVE.CRV_MINTER,
  );
  const hasOutflows = flows.some((f) => f.direction === "out");
  if (crvFromMinter && !hasOutflows) return "CLAIM_CRV";

  // Stake gauge: LP outflow + gauge token minted from 0x0
  if (lpOutflow && gaugeMinted) return "STAKE_GAUGE";

  // Unstake gauge: gauge token burned + LP inflow
  if (gaugeBurned && lpInflow) return "UNSTAKE_GAUGE";

  // Add liquidity: LP minted from 0x0 + underlying outflows
  if (lpMinted) return "ADD_LIQUIDITY";

  // Remove liquidity: LP burned to 0x0 + underlying inflows
  if (lpBurned) return "REMOVE_LIQUIDITY";

  // Swap: token A out + token B in via router, no LP mint/burn
  const inflows = flows.filter((f) => f.direction === "in");
  const outflows = flows.filter((f) => f.direction === "out");
  if (
    outflows.length > 0 &&
    inflows.length > 0 &&
    !lpMinted &&
    !lpBurned &&
    group.normal?.to.toLowerCase() === CURVE.ROUTER_NG
  ) {
    return "SWAP";
  }

  return "UNKNOWN";
}

// ---- Summary builder ----

const ACTION_LABELS: Record<CurveAction, string> = {
  SWAP: "Swap",
  ADD_LIQUIDITY: "Add Liquidity",
  REMOVE_LIQUIDITY: "Remove Liquidity",
  CLAIM_CRV: "Claim CRV",
  STAKE_GAUGE: "Stake Gauge",
  UNSTAKE_GAUGE: "Unstake Gauge",
  UNKNOWN: "Interact",
};

function buildSummary(
  action: CurveAction,
  flows: TokenFlow[],
  chainName: string,
): string {
  if (action === "SWAP") {
    const outflow = flows.find((f) => f.direction === "out");
    const inflow = flows.find((f) => f.direction === "in");
    if (outflow && inflow) {
      return `Curve (${chainName}): Swap ${outflow.symbol} \u2192 ${inflow.symbol}`;
    }
  }

  return `Curve (${chainName}): ${ACTION_LABELS[action]}`;
}

// ---- Enrichment via Curve API ----

interface CurveEnrichment {
  pool_base_apy: string;
  pool_reward_apy: string;
}

async function fetchCurveEnrichment(
  flows: TokenFlow[],
): Promise<CurveEnrichment | null> {
  // Identify the Curve LP token to find the pool
  const lpFlow = flows.find((f) => isCurveLP(f.symbol));
  if (!lpFlow) return null;

  const resp = await fetch("https://api.curve.fi/api/getPools/ethereum/main");
  if (!resp.ok) return null;

  const data = await resp.json();
  const pools = data?.data?.poolData;
  if (!Array.isArray(pools)) return null;

  // Match pool by LP token address or name containing the LP symbol
  const lpAddr = lpFlow.contractAddress.toLowerCase();
  const match = pools.find(
    (p: { lpTokenAddress?: string; name?: string }) =>
      p.lpTokenAddress?.toLowerCase() === lpAddr ||
      (p.name && lpFlow.symbol && p.name.toLowerCase().includes(lpFlow.symbol.toLowerCase())),
  );
  if (!match) return null;

  return {
    pool_base_apy: match.gaugeRewards?.[0]?.apy?.toString() ?? match.apy?.toString() ?? "",
    pool_reward_apy: match.gaugeCrvApy?.[0]?.toString() ?? "",
  };
}

// ---- Handler ----

export const curveHandler: TransactionHandler = {
  id: "curve",
  name: "Curve Finance",
  description: "Interprets Curve Finance swaps, liquidity, gauge staking, and CRV claims",
  website: "https://curve.fi",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check if normal tx is to Curve Router NG
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (to === CURVE.ROUTER_NG) return 55;
    }

    // Check ERC20 tokens for Curve LP or gauge tokens, or CRV Minter
    for (const erc20 of group.erc20s) {
      if (isCurveLP(erc20.tokenSymbol)) return 55;
      if (isGaugeToken(erc20.tokenSymbol)) return 55;
      if (erc20.from.toLowerCase() === CURVE.CRV_MINTER) return 55;
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(flows, group);

    // Ensure native currency for item building
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts for CRV claims
    if (action === "CLAIM_CRV") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Curve", "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    const summary = buildSummary(action, flows, ctx.chain.name);

    const metadata: Record<string, string> = {
      handler: "curve",
      "handler:action": action,
    };

    // Enrichment: fetch pool APY data from Curve API (opt-in)
    if (ctx.enrichment && (action === "ADD_LIQUIDITY" || action === "STAKE_GAUGE")) {
      try {
        const enrichment = await fetchCurveEnrichment(flows);
        if (enrichment) {
          metadata["handler:pool_base_apy"] = enrichment.pool_base_apy;
          metadata["handler:pool_reward_apy"] = enrichment.pool_reward_apy;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Curve enrichment failed: ${msg}`;
      }
    }

    const descData = { type: "defi" as const, protocol: "Curve", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash, summary };
    const handlerEntry = buildHandlerEntry({
      date,
      description: renderDescription(descData),
      descriptionData: descData,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: Curve LP tokens and gauge tokens should not have exchange rates
    const currencyHints: Record<string, null> = {};
    for (const item of allItems) {
      if (isCurveLP(item.currency) || isGaugeToken(item.currency)) {
        currencyHints[item.currency] = null;
      }
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
