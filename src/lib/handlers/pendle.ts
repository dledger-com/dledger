import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
  Erc20Tx,
} from "./types.js";
import { timestampToDate } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  resolveToLineItems,
  buildHandlerEntry,
} from "./item-builder.js";
import { ZERO_ADDRESS } from "./addresses.js";

// ---- Constants ----

const PENDLE_ROUTER_V4 = "0x888888888889758f76e7103c6cbf23abbf58f946";
const PENDLE_LIMIT_ROUTER = "0x000000000000c9b3e2c3ec88b1b4c0cd853f4321";

// ---- Token detection ----

function isPendleToken(symbol: string): boolean {
  return (
    /^PT-/.test(symbol) ||
    /^YT-/.test(symbol) ||
    /^SY-/.test(symbol) ||
    symbol === "PENDLE-LPT"
  );
}

// ---- Action classification ----

type PendleAction =
  | "MINT_PY"
  | "REDEEM_PY"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "BUY_PT"
  | "SELL_PT"
  | "BUY_YT"
  | "SELL_YT"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

const ACTION_LABELS: Record<PendleAction, string> = {
  MINT_PY: "Mint PT+YT from",
  REDEEM_PY: "Redeem PT+YT to",
  ADD_LIQUIDITY: "Add Liquidity to",
  REMOVE_LIQUIDITY: "Remove Liquidity from",
  BUY_PT: "Buy PT",
  SELL_PT: "Sell PT",
  BUY_YT: "Buy YT",
  SELL_YT: "Sell YT",
  CLAIM_REWARDS: "Claim Rewards from",
  UNKNOWN: "Interact with",
};

function classifyAction(erc20s: Erc20Tx[], addr: string): PendleAction {
  const ptTokens = erc20s.filter((tx) => tx.tokenSymbol.startsWith("PT-"));
  const ytTokens = erc20s.filter((tx) => tx.tokenSymbol.startsWith("YT-"));
  const lpTokens = erc20s.filter((tx) => tx.tokenSymbol === "PENDLE-LPT");

  const ptMinted = ptTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const ytMinted = ytTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const ptBurned = ptTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );
  const ytBurned = ytTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );
  const lpMinted = lpTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const lpBurned = lpTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );

  if (ptMinted && ytMinted) return "MINT_PY";
  if (ptBurned && ytBurned) return "REDEEM_PY";
  if (lpMinted) return "ADD_LIQUIDITY";
  if (lpBurned) return "REMOVE_LIQUIDITY";

  const hasLP = lpTokens.length > 0;

  const ptOutFromUser = ptTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ptOutFromUser && !hasLP) return "SELL_PT";

  const ptInToUser = ptTokens.some(
    (tx) => tx.to.toLowerCase() === addr && tx.from.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ptInToUser && !hasLP) return "BUY_PT";

  const ytOutFromUser = ytTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ytOutFromUser && !hasLP) return "SELL_YT";

  const ytInToUser = ytTokens.some(
    (tx) => tx.to.toLowerCase() === addr && tx.from.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ytInToUser && !hasLP) return "BUY_YT";

  const hasOutflows = erc20s.some((tx) => tx.from.toLowerCase() === addr);
  const hasInflows = erc20s.some((tx) => tx.to.toLowerCase() === addr);
  if (hasInflows && !hasOutflows) return "CLAIM_REWARDS";

  return "UNKNOWN";
}

// ---- Market name extraction ----

function extractMarketInfo(erc20s: Erc20Tx[]): {
  marketName: string;
  underlying: string;
} {
  for (const tx of erc20s) {
    const sym = tx.tokenSymbol;
    const ptMatch = sym.match(/^PT-(.+)$/);
    const ytMatch = sym.match(/^YT-(.+)$/);
    const syMatch = sym.match(/^SY-(.+)$/);

    if (ptMatch) {
      const market = ptMatch[1];
      const dashParts = market.split("-");
      const underlying = dashParts.length > 1 ? dashParts.slice(0, -1).join("-") : market;
      return { marketName: market, underlying };
    }
    if (ytMatch) {
      const market = ytMatch[1];
      const dashParts = market.split("-");
      const underlying = dashParts.length > 1 ? dashParts.slice(0, -1).join("-") : market;
      return { marketName: market, underlying };
    }
    if (syMatch) {
      return { marketName: syMatch[1], underlying: syMatch[1] };
    }
  }
  return { marketName: "", underlying: "" };
}

// ---- Pendle API enrichment ----

interface PendleApiResponse {
  total: number;
  limit: number;
  skip: number;
  results: Array<{
    txHash: string;
    action: string;
    valuation?: { usd?: number };
    impliedApy?: number;
    market?: { name?: string };
  }>;
}

interface PendleEnrichment {
  action: string;
  usd_value: string;
  implied_apy: string;
}

async function fetchPendleEnrichment(
  chainId: number,
  address: string,
  txHash: string,
): Promise<PendleEnrichment | null> {
  const url = `https://api-v2.pendle.finance/core/v5/${chainId}/transactions/${address}?limit=100&skip=0`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data: PendleApiResponse = await resp.json();
  const match = data.results.find(
    (r) => r.txHash.toLowerCase() === txHash.toLowerCase(),
  );
  if (!match) return null;

  return {
    action: match.action,
    usd_value: match.valuation?.usd?.toString() ?? "",
    implied_apy: match.impliedApy?.toString() ?? "",
  };
}

// ---- Handler ----

export const pendleHandler: TransactionHandler = {
  id: "pendle",
  name: "Pendle Finance",
  description: "Interprets Pendle yield trading transactions",
  supportedChainIds: [1, 42161, 8453, 56, 10, 5000, 43114],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    for (const erc20 of group.erc20s) {
      if (isPendleToken(erc20.tokenSymbol)) return 60;
    }

    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (to === PENDLE_ROUTER_V4 || to === PENDLE_LIMIT_ROUTER) return 60;
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const action = classifyAction(group.erc20s, addr);

    let enrichment: PendleEnrichment | null = null;
    const warnings: string[] = [];
    try {
      enrichment = await fetchPendleEnrichment(ctx.chainId, ctx.address, group.hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Pendle API enrichment failed: ${msg}`);
    }

    const { marketName, underlying } = extractMarketInfo(group.erc20s);

    // Ensure native currency for item building
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    const actionLabel = ACTION_LABELS[action];
    const marketInfo = marketName || underlying || "";
    const description = marketInfo
      ? `Pendle: ${actionLabel} ${marketInfo} (${hashShort})`
      : `Pendle: ${actionLabel} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "pendle",
      "handler:action": action,
      "handler:market": marketName || "",
      "handler:underlying": underlying || "",
    };
    if (enrichment) {
      metadata["handler:usd_value"] = enrichment.usd_value;
      metadata["handler:implied_apy"] = enrichment.implied_apy;
    }
    if (warnings.length > 0) {
      metadata["handler:warnings"] = warnings.join("; ");
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
    });

    const pendleTokens = allItems
      .map((i) => i.currency)
      .filter((c) => isPendleToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of pendleTokens) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
