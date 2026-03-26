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
import { AURA, isAuraContract, ZERO_ADDRESS } from "./addresses.js";
import { defiAssets, defiIncome } from "../accounts/paths.js";

// ---- Token detection ----

function isAuraPrefixed(symbol: string): boolean {
  return /^aura/i.test(symbol);
}

function isBalancerLpToken(symbol: string): boolean {
  return /^B-/i.test(symbol) || /^bb-/i.test(symbol);
}

// ---- Action classification ----

type AuraAction = "DEPOSIT" | "WITHDRAW" | "CLAIM_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<AuraAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(flows: TokenFlow[], group: TxHashGroup): AuraAction {
  const hasOutflows = flows.some((f) => f.direction === "out");
  const hasInflows = flows.some((f) => f.direction === "in");

  // CLAIM_REWARDS: BAL/AURA inflows with no outflows from user
  const rewardInflow = flows.some(
    (f) =>
      f.direction === "in" &&
      (f.symbol === "BAL" || f.symbol === "AURA"),
  );
  if (rewardInflow && !hasOutflows) return "CLAIM_REWARDS";

  // DEPOSIT: BPT outflow + aura-prefixed token minted
  const bptOutflow = flows.some((f) => f.direction === "out" && isBalancerLpToken(f.symbol));
  const auraMinted = flows.some(
    (f) => f.direction === "in" && f.isMint && isAuraPrefixed(f.symbol),
  );
  if (bptOutflow && auraMinted) return "DEPOSIT";
  // Also match: BPT outflow to Booster
  if (bptOutflow && group.normal && group.normal.to.toLowerCase() === AURA.BOOSTER) return "DEPOSIT";

  // WITHDRAW: aura-prefixed token burned + BPT inflow
  const auraBurned = flows.some(
    (f) => f.direction === "out" && f.isBurn && isAuraPrefixed(f.symbol),
  );
  const bptInflow = flows.some((f) => f.direction === "in" && isBalancerLpToken(f.symbol));
  if (auraBurned && bptInflow) return "WITHDRAW";

  // Fallback
  if (hasOutflows && !hasInflows) return "DEPOSIT";
  if (hasInflows && !hasOutflows) return "CLAIM_REWARDS";

  return "UNKNOWN";
}

// ---- Handler ----

export const auraHandler: TransactionHandler = {
  id: "aura",
  name: "Aura Finance",
  description: "Interprets Aura Finance deposits, withdrawals, and reward claims",
  website: "https://aura.finance",
  supportedChainIds: [1, 42161],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isAuraContract(group.normal.to)) return 60;
    }

    // Check ERC20 tokens for AURA, auraBAL, or aura-prefixed tokens
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "AURA" && erc20.contractAddress.toLowerCase() === AURA.AURA_TOKEN) return 60;
      if (erc20.tokenSymbol === "auraBAL" && erc20.contractAddress.toLowerCase() === AURA.AURA_BAL) return 60;
      if (isAuraPrefixed(erc20.tokenSymbol)) return 60;
      if (isAuraContract(erc20.from) || isAuraContract(erc20.to)) return 60;
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
    const action = classifyAction(flows, group);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts
    if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Aura", "Rewards") },
      ]);
    } else if (action === "DEPOSIT" || action === "WITHDRAW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Aura", "Staking") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primaryFlow = flows.find((f) =>
      action === "CLAIM_REWARDS"
        ? f.direction === "in"
        : action === "DEPOSIT"
          ? f.direction === "out"
          : f.direction === "in",
    );
    const amountStr = primaryFlow
      ? ` ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)}`
      : "";
    const description = `Aura: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "aura",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Aura", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: aura-prefixed tokens should not have exchange rates
    const currencyHints: Record<string, null> = {};
    for (const item of allItems) {
      if (isAuraPrefixed(item.currency)) {
        currencyHints[item.currency] = null;
      }
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
