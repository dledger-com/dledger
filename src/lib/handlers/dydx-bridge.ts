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
import { isDydxContract, DYDX } from "./addresses.js";
import { defiAssets, defiIncome } from "../accounts/paths.js";

// ---- Action classification ----

type DydxAction =
  | "BRIDGE_DEPOSIT"
  | "BRIDGE_WITHDRAWAL"
  | "STAKE_DYDX"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

const ACTION_LABELS: Record<DydxAction, string> = {
  BRIDGE_DEPOSIT: "Bridge Deposit",
  BRIDGE_WITHDRAWAL: "Bridge Withdrawal",
  STAKE_DYDX: "Stake DYDX",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): DydxAction {
  const dydxIn = flows.some(
    (f) => f.symbol === "DYDX" && f.direction === "in",
  );
  const dydxOut = flows.some(
    (f) => f.symbol === "DYDX" && f.direction === "out",
  );
  const hasOutflow = flows.some((f) => f.direction === "out");
  const hasInflow = flows.some((f) => f.direction === "in");

  // CLAIM_REWARDS: DYDX inflow with no outflows
  if (dydxIn && !hasOutflow) return "CLAIM_REWARDS";

  // STAKE_DYDX: DYDX outflow to Safety Module
  if (dydxOut && group.normal) {
    const to = group.normal.to.toLowerCase();
    if (to === DYDX.SAFETY_MODULE) return "STAKE_DYDX";
  }
  // Also check ERC20 destination
  if (dydxOut) {
    for (const erc20 of group.erc20s) {
      if (erc20.to.toLowerCase() === DYDX.SAFETY_MODULE) return "STAKE_DYDX";
    }
  }

  // BRIDGE_DEPOSIT: outflow (USDC/ETH) to StarkEx bridge
  if (hasOutflow && group.normal) {
    const to = group.normal.to.toLowerCase();
    if (to === DYDX.STARKEX_BRIDGE) return "BRIDGE_DEPOSIT";
  }
  if (hasOutflow) {
    for (const erc20 of group.erc20s) {
      if (erc20.to.toLowerCase() === DYDX.STARKEX_BRIDGE) return "BRIDGE_DEPOSIT";
    }
  }

  // BRIDGE_WITHDRAWAL: inflow from bridge
  if (hasInflow && !hasOutflow) {
    const hasInternalFromBridge = group.internals.some(
      (itx) => itx.from.toLowerCase() === DYDX.STARKEX_BRIDGE,
    );
    if (hasInternalFromBridge) return "BRIDGE_WITHDRAWAL";

    for (const erc20 of group.erc20s) {
      if (erc20.from.toLowerCase() === DYDX.STARKEX_BRIDGE) return "BRIDGE_WITHDRAWAL";
    }

    return "BRIDGE_WITHDRAWAL";
  }

  return "UNKNOWN";
}

// ---- Handler ----

export const dydxBridgeHandler: TransactionHandler = {
  id: "dydx-bridge",
  name: "dYdX Bridge",
  description: "Interprets dYdX StarkEx bridge deposits/withdrawals and DYDX staking",
  website: "https://dydx.exchange",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isDydxContract(group.normal.to)) return 50;
    }

    // Check ERC20 transfers
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "DYDX") {
        if (
          isDydxContract(erc20.from) ||
          isDydxContract(erc20.to)
        ) {
          return 50;
        }
      }
      if (
        erc20.from.toLowerCase() === DYDX.STARKEX_BRIDGE ||
        erc20.to.toLowerCase() === DYDX.STARKEX_BRIDGE
      ) {
        return 50;
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
    if (action === "STAKE_DYDX") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("dYdX", "Staking") },
      ]);
    } else if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("dYdX", "Rewards") },
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
    const description = `dYdX: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "dydx-bridge",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "dYdX", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
