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
import { isNotionalContract, NOTIONAL } from "./addresses.js";
import { defiAssets } from "../accounts/paths.js";

// ---- Action classification ----

type NotionalAction =
  | "LEND"
  | "REDEEM"
  | "BORROW"
  | "REPAY"
  | "PROVIDE_LIQUIDITY"
  | "UNKNOWN";

const ACTION_LABELS: Record<NotionalAction, string> = {
  LEND: "Lend",
  REDEEM: "Redeem",
  BORROW: "Borrow",
  REPAY: "Repay",
  PROVIDE_LIQUIDITY: "Provide Liquidity",
  UNKNOWN: "Interact",
};

/** nToken pattern: nUSDC, nDAI, nETH etc. */
function isNToken(symbol: string): boolean {
  return /^n[A-Z]/.test(symbol);
}

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): NotionalAction {
  const hasNTokenIn = flows.some((f) => f.direction === "in" && isNToken(f.symbol));
  const hasNTokenOut = flows.some((f) => f.direction === "out" && isNToken(f.symbol));
  const hasOutflow = flows.some((f) => f.direction === "out" && !isNToken(f.symbol));
  const hasInflow = flows.some((f) => f.direction === "in" && !isNToken(f.symbol));

  // PROVIDE_LIQUIDITY: nToken minted
  if (hasNTokenIn && hasOutflow) return "PROVIDE_LIQUIDITY";

  // LEND: underlying outflow to proxy (no nToken)
  if (hasOutflow && !hasNTokenIn && !hasNTokenOut) return "LEND";

  // REDEEM: underlying inflow from proxy
  if (hasInflow && !hasOutflow) return "REDEEM";

  // BORROW: underlying inflow + possible nToken interactions
  if (hasInflow && hasOutflow) return "BORROW";

  // REPAY: underlying outflow + nToken burn
  if (hasNTokenOut) return "REPAY";

  return "UNKNOWN";
}

// ---- Handler ----

export const notionalHandler: TransactionHandler = {
  id: "notional",
  name: "Notional Finance",
  description: "Interprets Notional fixed-rate lending and nToken liquidity transactions",
  website: "https://notional.finance",
  supportedChainIds: [1, 42161],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isNotionalContract(group.normal.to)) return 55;
    }

    // Check ERC20 transfers involving Notional proxy
    for (const erc20 of group.erc20s) {
      if (
        erc20.from.toLowerCase() === NOTIONAL.V3_PROXY ||
        erc20.to.toLowerCase() === NOTIONAL.V3_PROXY
      ) {
        return 55;
      }
      // nToken pattern — only match if also interacting with Notional contract
      if (isNToken(erc20.tokenSymbol) && group.normal) {
        if (isNotionalContract(group.normal.to)) return 55;
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
    if (action === "LEND" || action === "REDEEM") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Notional", "fCash") },
      ]);
    } else if (action === "PROVIDE_LIQUIDITY") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Notional", "Liquidity") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = flows.find((f) => !isNToken(f.symbol)) ?? flows[0];
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `Notional: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "notional",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Notional", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
