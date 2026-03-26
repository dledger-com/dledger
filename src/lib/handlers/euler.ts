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
import { isEulerContract } from "./addresses.js";
import { defiAssets, defiLiabilities } from "../accounts/paths.js";

// ---- Token detection ----

function isEToken(symbol: string): boolean {
  return /^e[A-Z]/.test(symbol);
}

// ---- Action classification ----

type EulerAction = "SUPPLY" | "WITHDRAW" | "BORROW" | "REPAY" | "UNKNOWN";

const ACTION_LABELS: Record<EulerAction, string> = {
  SUPPLY: "Supply",
  WITHDRAW: "Withdraw",
  BORROW: "Borrow",
  REPAY: "Repay",
  UNKNOWN: "Interact",
};

function classifyAction(
  group: TxHashGroup,
  addr: string,
): EulerAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);

  // Check if any Euler contract is involved in the tx
  const hasEulerTarget = group.normal != null &&
    isEulerContract(group.normal.to);
  const hasEulerErc20 = group.erc20s.some(
    (tx) => isEulerContract(tx.to) || isEulerContract(tx.from),
  );

  if (!hasEulerTarget && !hasEulerErc20) return "UNKNOWN";

  const hasOutflows = flows.some((f) => f.direction === "out" && !f.isBurn);
  const hasInflows = flows.some((f) => f.direction === "in" && !f.isMint);
  const hasMints = flows.some((f) => f.isMint);
  const hasBurns = flows.some((f) => f.isBurn);

  // Native ETH flow
  const hasNativeOut = group.normal != null && group.normal.value !== "0" &&
    group.normal.from.toLowerCase() === addr;
  const hasNativeIn = group.internals.some(
    (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
  );

  // Outflow only → SUPPLY
  if ((hasOutflows || hasNativeOut) && !hasInflows && !hasNativeIn) return "SUPPLY";

  // Inflow only → WITHDRAW
  if ((hasInflows || hasNativeIn) && !hasOutflows && !hasNativeOut) return "WITHDRAW";

  // Both directions
  if (hasOutflows && hasInflows) {
    if (hasBurns && !hasMints) return "REPAY";
    if (hasMints && !hasBurns) return "BORROW";
  }

  return "UNKNOWN";
}

// ---- Handler ----

export const eulerHandler: TransactionHandler = {
  id: "euler",
  name: "Euler Finance",
  description: "Interprets Euler V2 modular lending/borrowing transactions",
  website: "https://euler.finance",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isEulerContract(group.normal.to)) return 55;
    }

    // Check ERC20 transfers to/from Euler contracts
    const hasEulerErc20 = group.erc20s.some(
      (tx) => isEulerContract(tx.to) || isEulerContract(tx.from),
    );
    if (hasEulerErc20) return 55;

    // eToken pattern — only match if also interacting with an Euler contract
    // (avoid clashes with Ethena/ether.fi tokens)
    const hasETokens = group.erc20s.some((tx) => isEToken(tx.tokenSymbol));
    if (hasETokens) {
      // Check if any address in the tx belongs to Euler
      const eulerInvolved = group.erc20s.some(
        (tx) => isEulerContract(tx.to) || isEulerContract(tx.from),
      );
      if (eulerInvolved) return 55;
      if (group.normal && isEulerContract(group.normal.to)) return 55;
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
        { from: "Equity:*:External:*", to: defiLiabilities("Euler", "Borrow") },
      ]);
    } else if (action === "SUPPLY" || action === "WITHDRAW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Euler", "Supply") },
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
      description = `Euler: ${ACTION_LABELS[action]} ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)} (${hashShort})`;
    } else if (action !== "UNKNOWN" && group.normal && group.normal.value !== "0") {
      // Native ETH flow
      const ethAmount = weiToNative(group.normal.value, ctx.chain.decimals);
      description = `Euler: ${ACTION_LABELS[action]} ${formatTokenAmount(ethAmount, ctx.chain.native_currency)} (${hashShort})`;
    } else {
      description = `Euler: ${ACTION_LABELS[action]} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "euler",
      "handler:action": action,
    };

    const descriptionAction = action.toLowerCase().replace(/_/g, "-");
    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Euler", action: descriptionAction, chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
