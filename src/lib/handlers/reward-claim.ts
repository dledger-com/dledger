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
import { isRewardClaimContract, REWARD_CLAIMS } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";

// ---- Protocol names ----

const PROTOCOL_NAMES: Record<string, string> = {
  merkl: "Merkl",
  votium: "Votium",
};

// ---- Detect protocol from transaction ----

function detectProtocol(group: TxHashGroup): string | null {
  // Check normal tx target
  if (group.normal) {
    const result = isRewardClaimContract(group.normal.to);
    if (result) return result;
  }

  // Check ERC20 from addresses (rewards come from the distributor)
  for (const erc20 of group.erc20s) {
    const fromResult = isRewardClaimContract(erc20.from);
    if (fromResult) return fromResult;
  }

  // Check internal tx from addresses
  for (const itx of group.internals) {
    const result = isRewardClaimContract(itx.from);
    if (result) return result;
  }

  return null;
}

// ---- Find primary reward flow for description ----

function findPrimaryFlow(flows: TokenFlow[]): TokenFlow | undefined {
  // Pick the largest inflow
  const inflows = flows.filter((f) => f.direction === "in");
  if (inflows.length === 0) return flows[0];
  return inflows.reduce((best, f) =>
    f.amount.gt(best.amount) ? f : best,
  );
}

// ---- Handler ----

export const rewardClaimHandler: TransactionHandler = {
  id: "reward-claim",
  name: "Reward Claim",
  description: "Interprets pure reward claim transactions for Merkl and Votium",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isRewardClaimContract(group.normal.to)) return 52;
    }

    // Check ERC20 from addresses
    for (const erc20 of group.erc20s) {
      if (isRewardClaimContract(erc20.from)) return 52;
    }

    // Check internal tx from addresses
    for (const itx of group.internals) {
      if (isRewardClaimContract(itx.from)) return 52;
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

    const protocolId = detectProtocol(group);
    const protocolName = protocolId ? (PROTOCOL_NAMES[protocolId] ?? protocolId) : "Unknown";

    const flows = analyzeErc20Flows(group.erc20s, addr);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    let merged = mergeItemAccums(allItems);

    // All inflows reclassified to defi income
    merged = remapCounterpartyAccounts(merged, [
      { from: "Equity:*:External:*", to: defiIncome(protocolName, "Rewards") },
    ]);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = findPrimaryFlow(flows);
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `${protocolName}: Claim${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "reward-claim",
      "handler:action": "CLAIM",
      "handler:protocol": protocolName,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: protocolName, action: "claim", chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
