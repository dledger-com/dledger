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
import { isMorphoContract } from "./addresses.js";
import { defiAssets, defiLiabilities } from "../accounts/paths.js";

// ---- Action classification ----

type MorphoAction = "SUPPLY" | "WITHDRAW" | "BORROW" | "REPAY" | "UNKNOWN";

const ACTION_LABELS: Record<MorphoAction, string> = {
  SUPPLY: "Supply",
  WITHDRAW: "Withdraw",
  BORROW: "Borrow",
  REPAY: "Repay",
  UNKNOWN: "Interact",
};

function classifyAction(
  group: TxHashGroup,
  addr: string,
): MorphoAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);

  const hasOutflows = flows.some((f) => f.direction === "out" && !f.isBurn);
  const hasInflows = flows.some((f) => f.direction === "in" && !f.isMint);
  const hasMints = flows.some((f) => f.isMint);
  const hasBurns = flows.some((f) => f.isBurn);

  // Native ETH flow (supply ETH or receive ETH)
  const hasNativeOut = group.normal != null && group.normal.value !== "0" &&
    group.normal.from.toLowerCase() === addr;
  const hasNativeIn = group.internals.some(
    (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
  );

  // Only outflows (tokens sent to Morpho) → SUPPLY
  if ((hasOutflows || hasNativeOut) && !hasInflows && !hasNativeIn) return "SUPPLY";

  // Only inflows (tokens received from Morpho) → could be WITHDRAW or REPAY
  // Without deeper analysis, default to WITHDRAW
  if ((hasInflows || hasNativeIn) && !hasOutflows && !hasNativeOut) return "WITHDRAW";

  // Both directions — could be a borrow (receive tokens + mint share) or repay
  if (hasOutflows && hasInflows) {
    // If user sends tokens to Morpho and receives nothing meaningful back
    // or has burns (share token burned) → REPAY
    if (hasBurns && !hasMints) return "REPAY";
    // If user receives tokens and has mints (share token minted) → BORROW
    if (hasMints && !hasBurns) return "BORROW";
  }

  return "UNKNOWN";
}

// ---- Handler ----

export const morphoHandler: TransactionHandler = {
  id: "morpho",
  name: "Morpho",
  description: "Interprets Morpho Blue lending/borrowing transactions",
  website: "https://morpho.org",
  supportedChainIds: [1, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isMorphoContract(group.normal.to)) return 55;
    }

    // Check ERC20 transfers to/from Morpho Blue or Bundler
    for (const erc20 of group.erc20s) {
      if (isMorphoContract(erc20.to) || isMorphoContract(erc20.from)) {
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

    // Ensure native currency
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    // Classify the action
    const action = classifyAction(group, addr);

    // Build all group items (wallet-side flows + gas)
    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Remap counterparty accounts based on action
    if (action === "BORROW" || action === "REPAY") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiLiabilities("Morpho", "Borrow") },
      ]);
    } else if (action === "SUPPLY" || action === "WITHDRAW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Morpho", "Supply") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const flows = analyzeErc20Flows(group.erc20s, addr);
    const primaryFlow = flows.find((f) =>
      (action === "SUPPLY" && f.direction === "out") ||
      (action === "WITHDRAW" && f.direction === "in") ||
      (action === "BORROW" && f.direction === "in") ||
      (action === "REPAY" && f.direction === "out"),
    );

    let description: string;
    if (primaryFlow) {
      description = `Morpho: ${ACTION_LABELS[action]} ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)} (${hashShort})`;
    } else if (action !== "UNKNOWN" && group.normal && group.normal.value !== "0") {
      // Native ETH flow
      const ethAmount = weiToNative(group.normal.value, ctx.chain.decimals);
      description = `Morpho: ${ACTION_LABELS[action]} ${formatTokenAmount(ethAmount, ctx.chain.native_currency)} (${hashShort})`;
    } else {
      description = `Morpho: ${ACTION_LABELS[action]} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "morpho",
      "handler:action": action,
    };

    const descriptionAction = action.toLowerCase().replace(/_/g, "-");
    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Morpho", action: descriptionAction, chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
