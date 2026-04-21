import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "./types.js";
import { timestampToDate, weiToNative } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  remapCounterpartyAccounts,
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  formatTokenAmount,
} from "./item-builder.js";
import { DOLOMITE, isDolomiteContract } from "./addresses.js";
import { defiAssets, defiLiabilities, defiIncome } from "../accounts/paths.js";

// ---- Action classification ----

type DolomiteAction =
  | "SUPPLY"
  | "WITHDRAW"
  | "BORROW"
  | "REPAY"
  | "MARGIN_TRADE"
  | "CLAIM_DOLO"
  | "UNKNOWN";

const ACTION_LABELS: Record<DolomiteAction, string> = {
  SUPPLY: "Supply",
  WITHDRAW: "Withdraw",
  BORROW: "Borrow",
  REPAY: "Repay",
  MARGIN_TRADE: "Margin trade",
  CLAIM_DOLO: "Claim DOLO",
  UNKNOWN: "Interact",
};

function isDoloReward(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return upper === "DOLO" || upper === "VEDOLO" || upper === "ODOLO";
}

function usesGenericTrader(group: TxHashGroup): boolean {
  if (!group.normal) return false;
  const to = group.normal.to.toLowerCase();
  return (
    to === DOLOMITE.GENERIC_TRADER_ROUTER ||
    to === DOLOMITE.ARB_GENERIC_TRADER_PROXY_V1 ||
    to === DOLOMITE.BERA_GENERIC_TRADER_PROXY_V1
  );
}

function classifyAction(group: TxHashGroup, addr: string): DolomiteAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);

  // Reward-only inflow — e.g. oDOLO distribution.
  const nonRewardFlows = flows.filter((f) => !isDoloReward(f.symbol));
  const rewardInflow = flows.some(
    (f) => isDoloReward(f.symbol) && f.direction === "in",
  );
  if (rewardInflow && nonRewardFlows.length === 0) return "CLAIM_DOLO";

  // Margin trade: entry via GenericTrader and in+out of non-reward tokens.
  if (usesGenericTrader(group)) {
    const hasIn = nonRewardFlows.some((f) => f.direction === "in");
    const hasOut = nonRewardFlows.some((f) => f.direction === "out");
    if (hasIn && hasOut) return "MARGIN_TRADE";
  }

  const hasOutflows = nonRewardFlows.some((f) => f.direction === "out" && !f.isBurn);
  const hasInflows = nonRewardFlows.some((f) => f.direction === "in" && !f.isMint);
  const hasNativeOut =
    group.normal != null &&
    group.normal.value !== "0" &&
    group.normal.from.toLowerCase() === addr;
  const hasNativeIn = group.internals.some(
    (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
  );

  if ((hasOutflows || hasNativeOut) && !hasInflows && !hasNativeIn) return "SUPPLY";
  if ((hasInflows || hasNativeIn) && !hasOutflows && !hasNativeOut) {
    // Pure inflow via BorrowPositionProxy/Router = BORROW; otherwise WITHDRAW.
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (
        to === DOLOMITE.BORROW_POSITION_ROUTER ||
        to === DOLOMITE.ARB_BORROW_POSITION_PROXY_V2 ||
        to === DOLOMITE.BERA_BORROW_POSITION_PROXY_V2
      ) {
        return "BORROW";
      }
    }
    return "WITHDRAW";
  }
  if (hasOutflows && hasInflows) {
    // Both directions with no trader proxy involvement: most often repay with
    // change, or a composite deposit+borrow. Default to REPAY — users can
    // recategorize individual entries.
    return "REPAY";
  }

  return "UNKNOWN";
}

// ---- Handler ----

export const dolomiteHandler: TransactionHandler = {
  id: "dolomite",
  name: "Dolomite",
  description: "Interprets Dolomite margin and lending transactions",
  website: "https://dolomite.io",
  supportedChainIds: [1, 42161, 8453, 80094],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    if (group.normal && isDolomiteContract(group.normal.to, ctx.chainId)) {
      return 55;
    }
    for (const erc20 of group.erc20s) {
      if (
        isDolomiteContract(erc20.to, ctx.chainId) ||
        isDolomiteContract(erc20.from, ctx.chainId)
      ) {
        return 55;
      }
    }
    return 0;
  },

  async process(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const action = classifyAction(group, addr);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Remap the counterparty (DolomiteMargin / router) into protocol-specific
    // DeFi accounts so balances surface on the correct reports.
    switch (action) {
      case "SUPPLY":
      case "WITHDRAW":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiAssets("Dolomite", "Supply") },
        ]);
        break;
      case "BORROW":
      case "REPAY":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiLiabilities("Dolomite", "Borrow") },
        ]);
        break;
      case "MARGIN_TRADE":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiAssets("Dolomite", "Margin") },
        ]);
        break;
      case "CLAIM_DOLO":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiIncome("Dolomite", "Rewards") },
        ]);
        break;
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description around the primary flow.
    const flows = analyzeErc20Flows(group.erc20s, addr);
    const primaryFlow = flows.find((f) => {
      if (action === "CLAIM_DOLO") return isDoloReward(f.symbol) && f.direction === "in";
      if (action === "SUPPLY" || action === "REPAY") return f.direction === "out" && !isDoloReward(f.symbol);
      if (action === "WITHDRAW" || action === "BORROW") return f.direction === "in" && !isDoloReward(f.symbol);
      if (action === "MARGIN_TRADE") return f.direction === "in" && !isDoloReward(f.symbol);
      return false;
    });

    let description: string;
    if (primaryFlow) {
      description = `Dolomite: ${ACTION_LABELS[action]} ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)} (${hashShort})`;
    } else if (group.normal && group.normal.value !== "0" && action !== "UNKNOWN") {
      const ethAmount = weiToNative(group.normal.value, ctx.chain.decimals);
      description = `Dolomite: ${ACTION_LABELS[action]} ${formatTokenAmount(ethAmount, ctx.chain.native_currency)} (${hashShort})`;
    } else {
      description = `Dolomite: ${ACTION_LABELS[action]} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "dolomite",
      "handler:action": action,
    };

    const descriptionAction = action.toLowerCase().replace(/_/g, "-");
    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: {
        type: "defi",
        protocol: "Dolomite",
        action: descriptionAction,
        chain: ctx.chain.name,
        txHash: group.hash,
      },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
