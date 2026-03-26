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
import { isGmxContract, ZERO_ADDRESS } from "./addresses.js";
import { defiAssets, defiIncome, defiExpense } from "../accounts/paths.js";

// ---- Action classification ----

type GmxAction =
  | "OPEN_POSITION"
  | "CLOSE_POSITION"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "UNKNOWN";

const ACTION_LABELS: Record<GmxAction, string> = {
  OPEN_POSITION: "Open Position",
  CLOSE_POSITION: "Close Position",
  ADD_LIQUIDITY: "Add Liquidity",
  REMOVE_LIQUIDITY: "Remove Liquidity",
  UNKNOWN: "Interact",
};

function isGmToken(symbol: string): boolean {
  return /^GM[:\-]/.test(symbol);
}

function isGlpToken(symbol: string): boolean {
  return symbol === "GLP";
}

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): GmxAction {
  const hasGmInflow = flows.some((f) => f.direction === "in" && isGmToken(f.symbol));
  const hasGmOutflow = flows.some((f) => f.direction === "out" && isGmToken(f.symbol));
  const hasGlpInflow = flows.some((f) => f.direction === "in" && isGlpToken(f.symbol));
  const hasGlpOutflow = flows.some((f) => f.direction === "out" && isGlpToken(f.symbol));

  // Liquidity: GM/GLP token minted or burned
  if (hasGmInflow || hasGlpInflow) return "ADD_LIQUIDITY";
  if (hasGmOutflow || hasGlpOutflow) return "REMOVE_LIQUIDITY";

  // Perp position: check flow directions
  const hasOutflow = flows.some((f) => f.direction === "out");
  const hasInflow = flows.some((f) => f.direction === "in");
  const hasInternalEth = group.internals.some(
    (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
  );

  // CLOSE: inflow from GMX (profit/collateral returned) or internal ETH
  if ((hasInflow || hasInternalEth) && !hasOutflow) return "CLOSE_POSITION";

  // OPEN: outflow (collateral deposit) without liquidity tokens
  if (hasOutflow) return "OPEN_POSITION";

  return "UNKNOWN";
}

// ---- Handler ----

export const gmxHandler: TransactionHandler = {
  id: "gmx",
  name: "GMX",
  description: "Interprets GMX perpetual DEX transactions (positions, GLP/GM liquidity)",
  website: "https://gmx.io",
  supportedChainIds: [42161, 43114],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isGmxContract(group.normal.to)) return 55;
    }

    // Check ERC20 symbols for GM/GLP tokens
    for (const erc20 of group.erc20s) {
      if (isGmToken(erc20.tokenSymbol) || isGlpToken(erc20.tokenSymbol)) {
        return 55;
      }
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
    const action = classifyAction(flows, group, addr);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Remap accounts based on action
    if (action === "OPEN_POSITION") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("GMX", "Margin") },
      ]);
    } else if (action === "CLOSE_POSITION") {
      // PnL: inflows from closing → income or expense
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("GMX", "Trading") },
      ]);
    } else if (action === "ADD_LIQUIDITY" || action === "REMOVE_LIQUIDITY") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("GMX", "Liquidity") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = flows[0];
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `GMX: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "gmx",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "GMX", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
