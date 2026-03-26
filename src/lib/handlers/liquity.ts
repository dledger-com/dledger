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
import { LIQUITY, isLiquityContract, ZERO_ADDRESS } from "./addresses.js";
import { defiAssets, defiLiabilities, defiIncome } from "../accounts/paths.js";

// ---- Action classification ----

type LiquityAction =
  | "OPEN_TROVE"
  | "ADJUST_TROVE"
  | "CLOSE_TROVE"
  | "STABILITY_DEPOSIT"
  | "STABILITY_WITHDRAW"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

const ACTION_LABELS: Record<LiquityAction, string> = {
  OPEN_TROVE: "Open Trove",
  ADJUST_TROVE: "Adjust Trove",
  CLOSE_TROVE: "Close Trove",
  STABILITY_DEPOSIT: "Stability Deposit",
  STABILITY_WITHDRAW: "Stability Withdraw",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): LiquityAction {
  const to = group.normal?.to?.toLowerCase() ?? "";

  const lusdMinted = flows.some((f) => f.symbol === "LUSD" && f.isMint);
  const lusdBurned = flows.some((f) => f.symbol === "LUSD" && f.isBurn);
  const lusdIn = flows.some((f) => f.symbol === "LUSD" && f.direction === "in");
  const lusdOut = flows.some((f) => f.symbol === "LUSD" && f.direction === "out");

  const lqtyIn = flows.some((f) => f.symbol === "LQTY" && f.direction === "in");
  const ethIn = group.internals.some((i) => i.to.toLowerCase() === addr && BigInt(i.value) > 0n);

  const hasOutflow = flows.some((f) => f.direction === "out");

  // BorrowerOperations interactions
  if (to === LIQUITY.BORROWER_OPERATIONS) {
    if (lusdMinted && lusdBurned) return "ADJUST_TROVE";
    if (lusdMinted) return "OPEN_TROVE";
    if (lusdBurned) return "CLOSE_TROVE";
    return "ADJUST_TROVE";
  }

  // StabilityPool interactions
  if (to === LIQUITY.STABILITY_POOL) {
    if (lusdOut) return "STABILITY_DEPOSIT";
    if (lusdIn) return "STABILITY_WITHDRAW";
  }

  // Reward claims: LQTY or ETH inflow from StabilityPool/LQTYStaking with no outflows
  if ((lqtyIn || ethIn) && !hasOutflow) {
    const fromStabilityOrStaking = flows.some(
      (f) =>
        f.direction === "in" &&
        (f.from.toLowerCase() === LIQUITY.STABILITY_POOL ||
          f.from.toLowerCase() === LIQUITY.LQTY_STAKING),
    );
    if (fromStabilityOrStaking) return "CLAIM_REWARDS";
  }

  // LQTYStaking interactions
  if (to === LIQUITY.LQTY_STAKING) {
    if (lqtyIn && !hasOutflow) return "CLAIM_REWARDS";
  }

  return "UNKNOWN";
}

// ---- Find primary flow for description ----

function findPrimaryFlow(flows: TokenFlow[]): TokenFlow | undefined {
  // Prefer LUSD flow, then LQTY, then any
  return (
    flows.find((f) => f.symbol === "LUSD") ??
    flows.find((f) => f.symbol === "LQTY") ??
    flows[0]
  );
}

// ---- Handler ----

export const liquityHandler: TransactionHandler = {
  id: "liquity",
  name: "Liquity",
  description: "Interprets Liquity V1 trove, stability pool, and staking transactions",
  website: "https://www.liquity.org",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check ERC20 symbols for LUSD or LQTY
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "LUSD" || erc20.tokenSymbol === "LQTY") {
        return 55;
      }
    }

    // Check normal tx target
    if (group.normal) {
      if (isLiquityContract(group.normal.to)) return 55;
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort =
      group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(flows, group, addr);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts based on action
    switch (action) {
      case "OPEN_TROVE":
      case "ADJUST_TROVE":
        // Minted LUSD comes from Equity:External — remap to Trove debt liability
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiLiabilities("Liquity", "Trove") },
        ]);
        break;
      case "CLOSE_TROVE":
        // Burned LUSD goes to Equity:External — remap to Trove debt liability
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiLiabilities("Liquity", "Trove") },
        ]);
        break;
      case "STABILITY_DEPOSIT":
      case "STABILITY_WITHDRAW":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiAssets("Liquity", "StabilityPool") },
        ]);
        break;
      case "CLAIM_REWARDS":
        merged = remapCounterpartyAccounts(merged, [
          { from: "Equity:*:External:*", to: defiIncome("Liquity", "Rewards") },
        ]);
        break;
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = findPrimaryFlow(flows);
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `Liquity: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "liquity",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: {
        type: "defi",
        protocol: "Liquity",
        action: ACTION_LABELS[action],
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
