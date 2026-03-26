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
import { isOriginContract, ORIGIN } from "./addresses.js";
import { defiAssets } from "../accounts/paths.js";

// ---- Action classification ----

type OriginAction = "MINT" | "REDEEM" | "WRAP" | "UNWRAP" | "UNKNOWN";

const ACTION_LABELS: Record<OriginAction, string> = {
  MINT: "Mint",
  REDEEM: "Redeem",
  WRAP: "Wrap",
  UNWRAP: "Unwrap",
  UNKNOWN: "Interact",
};

const ORIGIN_YIELD_TOKENS = new Set(["OUSD", "OETH"]);
const ORIGIN_WRAPPED_TOKENS = new Set(["WOUSD", "WOETH"]);
const ORIGIN_ALL_TOKENS = new Set([...ORIGIN_YIELD_TOKENS, ...ORIGIN_WRAPPED_TOKENS]);

function isOriginToken(symbol: string): boolean {
  return ORIGIN_ALL_TOKENS.has(symbol);
}

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): OriginAction {
  const hasYieldIn = flows.some((f) => f.direction === "in" && ORIGIN_YIELD_TOKENS.has(f.symbol));
  const hasYieldOut = flows.some((f) => f.direction === "out" && ORIGIN_YIELD_TOKENS.has(f.symbol));
  const hasWrappedIn = flows.some((f) => f.direction === "in" && ORIGIN_WRAPPED_TOKENS.has(f.symbol));
  const hasWrappedOut = flows.some((f) => f.direction === "out" && ORIGIN_WRAPPED_TOKENS.has(f.symbol));

  // WRAP: OUSD→WOUSD or OETH→WOETH
  if (hasYieldOut && hasWrappedIn) return "WRAP";

  // UNWRAP: WOUSD→OUSD or WOETH→OETH
  if (hasWrappedOut && hasYieldIn) return "UNWRAP";

  // MINT: non-Origin tokens out + yield tokens in
  if (hasYieldIn) return "MINT";

  // REDEEM: yield tokens out + underlying in
  if (hasYieldOut) return "REDEEM";

  return "UNKNOWN";
}

// ---- Handler ----

export const originHandler: TransactionHandler = {
  id: "origin",
  name: "Origin Protocol",
  description: "Interprets Origin OUSD/OETH rebasing yield token transactions",
  website: "https://originprotocol.com",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isOriginContract(group.normal.to)) return 55;
    }

    // Check ERC20 symbols
    for (const erc20 of group.erc20s) {
      if (isOriginToken(erc20.tokenSymbol)) {
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
    if (action === "MINT" || action === "REDEEM") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Origin", "Supply") },
      ]);
    } else if (action === "WRAP" || action === "UNWRAP") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Origin", "Wrapped") },
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
    const description = `Origin: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "origin",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Origin", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
