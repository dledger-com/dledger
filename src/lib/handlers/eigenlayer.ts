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
  type TokenFlow,
} from "./item-builder.js";
import { EIGENLAYER, isEigenLayerContract } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";
import { renderDescription } from "../types/description-data.js";

// ---- Action classification ----

type EigenLayerAction = "DEPOSIT" | "WITHDRAW" | "CLAIM_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<EigenLayerAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): EigenLayerAction {
  const eigenInflow = flows.some(
    (f) =>
      f.symbol === "EIGEN" &&
      f.direction === "in" &&
      f.contractAddress === EIGENLAYER.EIGEN_TOKEN,
  );
  const hasOutflow = flows.some((f) => f.direction === "out");
  const hasInflow = flows.some((f) => f.direction === "in");

  // CLAIM_REWARDS: EIGEN inflow with no outflows
  if (eigenInflow && !hasOutflow) return "CLAIM_REWARDS";

  // DEPOSIT: outflow of stETH/rETH/etc to strategy manager
  if (hasOutflow && group.normal) {
    const to = group.normal.to.toLowerCase();
    if (
      to === EIGENLAYER.STRATEGY_MANAGER ||
      to === EIGENLAYER.DELEGATION_MANAGER
    ) {
      return "DEPOSIT";
    }
  }

  // DEPOSIT: outflow to known EigenLayer contracts
  if (hasOutflow) {
    for (const erc20 of group.erc20s) {
      if (
        erc20.to.toLowerCase() === EIGENLAYER.STRATEGY_MANAGER ||
        erc20.to.toLowerCase() === EIGENLAYER.DELEGATION_MANAGER
      ) {
        return "DEPOSIT";
      }
    }
  }

  // WITHDRAW: inflow from EigenLayer contracts
  if (hasInflow && !hasOutflow) {
    // Check if internals come from EigenLayer
    const hasEigenInternal = group.internals.some(
      (itx) =>
        itx.from.toLowerCase() === EIGENLAYER.DELEGATION_MANAGER ||
        itx.from.toLowerCase() === EIGENLAYER.STRATEGY_MANAGER,
    );
    if (hasEigenInternal) return "WITHDRAW";

    // Check ERC20 from EigenLayer
    for (const erc20 of group.erc20s) {
      if (
        erc20.from.toLowerCase() === EIGENLAYER.STRATEGY_MANAGER ||
        erc20.from.toLowerCase() === EIGENLAYER.DELEGATION_MANAGER
      ) {
        return "WITHDRAW";
      }
    }
  }

  // Fallback: if normal tx to EigenLayer with outflows, assume deposit
  if (hasOutflow) return "DEPOSIT";
  if (hasInflow) return "WITHDRAW";

  return "UNKNOWN";
}

// ---- Find primary token flow for description ----

function findPrimaryFlow(flows: TokenFlow[]): TokenFlow | undefined {
  // Prefer non-EIGEN tokens for the description
  const nonEigen = flows.find((f) => f.symbol !== "EIGEN");
  return nonEigen ?? flows[0];
}

// ---- Handler ----

export const eigenLayerHandler: TransactionHandler = {
  id: "eigenlayer",
  name: "EigenLayer",
  description: "Interprets EigenLayer restaking deposit/withdraw and reward transactions",
  website: "https://eigenlayer.xyz",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isEigenLayerContract(group.normal.to)) return 55;
    }

    // Check ERC20 transfers involving EigenLayer contracts
    for (const erc20 of group.erc20s) {
      if (
        erc20.contractAddress.toLowerCase() === EIGENLAYER.EIGEN_TOKEN &&
        erc20.tokenSymbol === "EIGEN"
      ) {
        return 55;
      }
      if (
        erc20.from.toLowerCase() === EIGENLAYER.STRATEGY_MANAGER ||
        erc20.to.toLowerCase() === EIGENLAYER.STRATEGY_MANAGER ||
        erc20.from.toLowerCase() === EIGENLAYER.DELEGATION_MANAGER ||
        erc20.to.toLowerCase() === EIGENLAYER.DELEGATION_MANAGER
      ) {
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
    if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("EigenLayer", "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const summary = `EigenLayer (${ctx.chain.name}): ${ACTION_LABELS[action]}`;

    const metadata: Record<string, string> = {
      handler: "eigenlayer",
      "handler:action": action,
    };

    const descData = { type: "defi" as const, protocol: "EigenLayer", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash, summary };
    const handlerEntry = buildHandlerEntry({
      date,
      description: renderDescription(descData),
      descriptionData: descData,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
