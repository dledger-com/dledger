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
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  formatTokenAmount,
  type TokenFlow,
} from "./item-builder.js";
import { ZERO_ADDRESS, UNISWAP, isUniswapRouter } from "./addresses.js";

// ---- Action types ----

type UniswapAction =
  | "SWAP"
  | "ADD_LIQUIDITY_V2"
  | "REMOVE_LIQUIDITY_V2"
  | "MINT_POSITION_V3"
  | "COLLECT_FEES_V3"
  | "REMOVE_POSITION_V3"
  | "UNKNOWN";

const ACTION_LABELS: Record<UniswapAction, string> = {
  SWAP: "Swap",
  ADD_LIQUIDITY_V2: "Add Liquidity V2",
  REMOVE_LIQUIDITY_V2: "Remove Liquidity V2",
  MINT_POSITION_V3: "Mint Position V3",
  COLLECT_FEES_V3: "Collect Fees V3",
  REMOVE_POSITION_V3: "Remove Position V3",
  UNKNOWN: "Interact",
};

// ---- Classification ----

function classifyAction(group: TxHashGroup, flows: TokenFlow[], addr: string): UniswapAction {
  // Check for UNI-V2 LP token mint/burn
  const v2Minted = flows.some((f) => f.symbol === "UNI-V2" && f.isMint && f.direction === "in");
  const v2Burned = flows.some((f) => f.symbol === "UNI-V2" && f.isBurn && f.direction === "out");

  if (v2Minted) return "ADD_LIQUIDITY_V2";
  if (v2Burned) return "REMOVE_LIQUIDITY_V2";

  // Check for UNI-V3-POS NFT mint/burn
  const nftMinted = group.erc721s.some(
    (tx) =>
      (tx.tokenSymbol === "UNI-V3-POS") &&
      tx.from.toLowerCase() === ZERO_ADDRESS &&
      tx.to.toLowerCase() === addr,
  );
  const nftBurned = group.erc721s.some(
    (tx) =>
      (tx.tokenSymbol === "UNI-V3-POS") &&
      tx.from.toLowerCase() === addr &&
      tx.to.toLowerCase() === ZERO_ADDRESS,
  );

  if (nftMinted) return "MINT_POSITION_V3";
  if (nftBurned) return "REMOVE_POSITION_V3";

  // Check for fee collection: ERC20 inflows from PositionManager, no NFT activity
  const hasInflowFromPM = flows.some(
    (f) => f.direction === "in" && f.from === UNISWAP.POSITION_MANAGER_V3,
  );
  if (hasInflowFromPM && !nftMinted && !nftBurned) return "COLLECT_FEES_V3";

  // Swap: token outflow + token inflow, no LP mint/burn, no NFT activity
  const hasOutflow = flows.some((f) => f.direction === "out");
  const hasInflow = flows.some((f) => f.direction === "in");
  if (hasOutflow && hasInflow) return "SWAP";

  // Fallback: if there's any movement via a Uniswap router
  if (group.normal && isUniswapRouter(group.normal.to)) return "SWAP";

  return "UNKNOWN";
}

// ---- Version detection ----

function detectVersion(group: TxHashGroup, flows: TokenFlow[]): string {
  // UNI-V2 LP token present
  if (flows.some((f) => f.symbol === "UNI-V2")) return "V2";

  // UNI-V3-POS NFT present
  if (group.erc721s.some((tx) => tx.tokenSymbol === "UNI-V3-POS")) return "V3";

  // V4 universal router
  if (group.normal && group.normal.to.toLowerCase() === UNISWAP.V4_UNIVERSAL_ROUTER) return "V4";

  return "V3";
}

// ---- Swap description ----

function buildSwapDescription(flows: TokenFlow[], hashShort: string): string {
  const outFlow = flows.find((f) => f.direction === "out");
  const inFlow = flows.find((f) => f.direction === "in");

  if (outFlow && inFlow) {
    const fromStr = formatTokenAmount(outFlow.amount, outFlow.symbol);
    const toStr = formatTokenAmount(inFlow.amount, inFlow.symbol);
    return `Uniswap: Swap ${fromStr} for ${toStr} (${hashShort})`;
  }

  return `Uniswap: Swap (${hashShort})`;
}

// ---- Handler ----

export const uniswapHandler: TransactionHandler = {
  id: "uniswap",
  name: "Uniswap",
  description: "Interprets Uniswap swap and liquidity transactions",
  supportedChainIds: [1, 42161, 10, 137, 8453, 56, 43114],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check normal.to against all Uniswap routers
    if (group.normal && isUniswapRouter(group.normal.to)) return 55;

    // Check ERC20 symbol for UNI-V2
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "UNI-V2") return 55;
    }

    // Check ERC721 symbol for UNI-V3-POS
    for (const erc721 of group.erc721s) {
      if (erc721.tokenSymbol === "UNI-V3-POS") return 55;
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

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(group, flows, addr);
    const version = detectVersion(group, flows);

    // Ensure native currency for item building
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    let description: string;
    if (action === "SWAP") {
      description = buildSwapDescription(flows, hashShort);
    } else {
      description = `Uniswap: ${ACTION_LABELS[action]} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "uniswap",
      "handler:action": action,
      "handler:version": version,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
    });

    // Currency hints: UNI-V2 LP tokens have no public rate source
    const currencyHints: Record<string, string | null> = {};
    const v2LpTokens = allItems
      .map((i) => i.currency)
      .filter((c) => c === "UNI-V2")
      .filter((c, i, arr) => arr.indexOf(c) === i);
    for (const token of v2LpTokens) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
