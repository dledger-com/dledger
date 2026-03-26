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
  formatTokenAmount,
  type TokenFlow,
} from "./item-builder.js";
import { CONVEX, isConvexContract, ZERO_ADDRESS } from "./addresses.js";
import { defiAssets, defiIncome } from "../accounts/paths.js";

// ---- Token detection ----

function isCvxPrefixed(symbol: string): boolean {
  return /^cvx/i.test(symbol);
}

function isLpToken(symbol: string): boolean {
  // Curve LP tokens often contain "crv" or are pool tokens deposited into Convex
  return /crv/i.test(symbol) || symbol.endsWith("-f") || symbol.endsWith("-gauge");
}

// ---- Action classification ----

type ConvexAction = "DEPOSIT" | "WITHDRAW" | "CLAIM_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<ConvexAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(flows: TokenFlow[], group: TxHashGroup): ConvexAction {
  const hasOutflows = flows.some((f) => f.direction === "out");
  const hasInflows = flows.some((f) => f.direction === "in");

  // CLAIM_REWARDS: CRV/CVX inflows with no outflows from user
  const rewardInflow = flows.some(
    (f) =>
      f.direction === "in" &&
      (f.symbol === "CRV" || f.symbol === "CVX"),
  );
  if (rewardInflow && !hasOutflows) return "CLAIM_REWARDS";

  // DEPOSIT: LP token outflow + cvx-prefixed token minted
  const lpOutflow = flows.some((f) => f.direction === "out" && isLpToken(f.symbol));
  const cvxMinted = flows.some(
    (f) => f.direction === "in" && f.isMint && isCvxPrefixed(f.symbol),
  );
  if (lpOutflow && cvxMinted) return "DEPOSIT";
  // Also match: LP outflow to Booster without explicit cvx mint
  if (lpOutflow && group.normal && group.normal.to.toLowerCase() === CONVEX.BOOSTER) return "DEPOSIT";

  // WITHDRAW: cvx-prefixed token burned + LP inflow
  const cvxBurned = flows.some(
    (f) => f.direction === "out" && f.isBurn && isCvxPrefixed(f.symbol),
  );
  const lpInflow = flows.some((f) => f.direction === "in" && isLpToken(f.symbol));
  if (cvxBurned && lpInflow) return "WITHDRAW";

  // Fallback: outflows to Convex = DEPOSIT, inflows from Convex = WITHDRAW
  if (hasOutflows && !hasInflows) return "DEPOSIT";
  if (hasInflows && !hasOutflows) return "CLAIM_REWARDS";

  return "UNKNOWN";
}

// ---- Handler ----

export const convexHandler: TransactionHandler = {
  id: "convex",
  name: "Convex Finance",
  description: "Interprets Convex Finance deposits, withdrawals, and reward claims",
  website: "https://www.convexfinance.com",
  supportedChainIds: [1],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isConvexContract(group.normal.to)) return 60;
    }

    // Check ERC20 tokens for CVX, cvxCRV, or cvx-prefixed tokens
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "CVX" && erc20.contractAddress.toLowerCase() === CONVEX.CVX_TOKEN) return 60;
      if (erc20.tokenSymbol === "cvxCRV" && erc20.contractAddress.toLowerCase() === CONVEX.CVX_CRV) return 60;
      if (isCvxPrefixed(erc20.tokenSymbol)) return 60;
      if (isConvexContract(erc20.from) || isConvexContract(erc20.to)) return 60;
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
    const action = classifyAction(flows, group);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts
    if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Convex", "Rewards") },
      ]);
    } else if (action === "DEPOSIT" || action === "WITHDRAW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Convex", "Staking") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primaryFlow = flows.find((f) =>
      action === "CLAIM_REWARDS"
        ? f.direction === "in"
        : action === "DEPOSIT"
          ? f.direction === "out"
          : f.direction === "in",
    );
    const amountStr = primaryFlow
      ? ` ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)}`
      : "";
    const description = `Convex: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "convex",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Convex", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: cvx-prefixed tokens should not have exchange rates
    const currencyHints: Record<string, null> = {};
    for (const item of allItems) {
      if (isCvxPrefixed(item.currency)) {
        currencyHints[item.currency] = null;
      }
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
