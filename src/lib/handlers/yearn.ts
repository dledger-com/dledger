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
import { ZERO_ADDRESS, isYearnContract } from "./addresses.js";

// ---- Token detection ----

function isYvToken(symbol: string): boolean {
  return /^yv[A-Z]/.test(symbol);
}

// ---- Action classification ----

type YearnAction = "DEPOSIT" | "WITHDRAW" | "HARVEST_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<YearnAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  HARVEST_REWARDS: "Harvest Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(flows: TokenFlow[]): YearnAction {
  const yvMinted = flows.some((f) => isYvToken(f.symbol) && f.isMint);
  const yvBurned = flows.some((f) => isYvToken(f.symbol) && f.isBurn);
  const hasNonYvInflow = flows.some(
    (f) => f.direction === "in" && !isYvToken(f.symbol),
  );
  const hasNonYvOutflow = flows.some(
    (f) => f.direction === "out" && !isYvToken(f.symbol),
  );

  // DEPOSIT: yvToken minted + underlying outflow
  if (yvMinted && hasNonYvOutflow) return "DEPOSIT";

  // WITHDRAW: yvToken burned + underlying inflow
  if (yvBurned && hasNonYvInflow) return "WITHDRAW";

  // HARVEST_REWARDS: only inflows, no yvToken mints/burns
  if (!yvMinted && !yvBurned && hasNonYvInflow && !hasNonYvOutflow) {
    return "HARVEST_REWARDS";
  }

  return "UNKNOWN";
}

// ---- Find underlying token flow ----

function findUnderlyingFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find((f) => !isYvToken(f.symbol));
}

// ---- Handler ----

export const yearnHandler: TransactionHandler = {
  id: "yearn",
  name: "Yearn Finance",
  description: "Interprets Yearn vault deposit/withdraw transactions",
  supportedChainIds: [1, 42161, 10, 137],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check ERC20 symbols for yvTokens
    for (const erc20 of group.erc20s) {
      if (isYvToken(erc20.tokenSymbol)) return 55;
    }

    // Check normal tx target
    if (group.normal) {
      if (isYearnContract(group.normal.to)) return 55;
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
    const action = classifyAction(flows);

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
    if (action === "HARVEST_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Income:Yearn:Rewards" },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const underlying = findUnderlyingFlow(flows);
    const amountStr = underlying
      ? ` ${formatTokenAmount(underlying.amount, underlying.symbol)}`
      : "";
    const description = `Yearn: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "yearn",
      "handler:action": action,
    };

    // Find yvToken symbol for metadata
    const yvTokenSymbol =
      group.erc20s.find((tx) => isYvToken(tx.tokenSymbol))?.tokenSymbol ?? "";
    if (yvTokenSymbol) {
      metadata["handler:vault_token"] = yvTokenSymbol;
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
    });

    // Currency hints: yvTokens should not fetch exchange rates
    const yvTokenCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isYvToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of yvTokenCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
