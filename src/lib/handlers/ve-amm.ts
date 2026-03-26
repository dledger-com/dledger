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
import { VE_AMM, isVeAmmRouter, ZERO_ADDRESS } from "./addresses.js";
import { defiAssets, defiIncome } from "../accounts/paths.js";

// ---- Protocol config ----

interface VeAmmProtocol {
  name: string;
  chainId: number;
  rewardSymbol: string;
}

const PROTOCOL_CONFIG: Record<"aerodrome" | "velodrome", VeAmmProtocol> = {
  aerodrome: { name: "Aerodrome", chainId: 8453, rewardSymbol: "AERO" },
  velodrome: { name: "Velodrome", chainId: 10, rewardSymbol: "VELO" },
};

// ---- Token detection ----

function isLpToken(symbol: string): boolean {
  // Solidly fork LP tokens: vAMM-X/Y, sAMM-X/Y
  return /^[vs]AMM-/i.test(symbol);
}

// ---- Action classification ----

type VeAmmAction =
  | "SWAP"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "CLAIM_FEES"
  | "CLAIM_EMISSIONS"
  | "UNKNOWN";

const ACTION_LABELS: Record<VeAmmAction, string> = {
  SWAP: "Swap",
  ADD_LIQUIDITY: "Add Liquidity",
  REMOVE_LIQUIDITY: "Remove Liquidity",
  CLAIM_FEES: "Claim Fees",
  CLAIM_EMISSIONS: "Claim Emissions",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  protocolId: "aerodrome" | "velodrome" | null,
): VeAmmAction {
  const lpMinted = flows.some(
    (f) => f.direction === "in" && f.isMint && isLpToken(f.symbol),
  );
  const lpBurned = flows.some(
    (f) => f.direction === "out" && f.isBurn && isLpToken(f.symbol),
  );

  const hasInflows = flows.filter((f) => f.direction === "in");
  const hasOutflows = flows.filter((f) => f.direction === "out");

  // CLAIM_EMISSIONS: AERO/VELO inflow from gauge with no outflows
  const rewardSymbol = protocolId ? PROTOCOL_CONFIG[protocolId].rewardSymbol : null;
  const emissionInflow = rewardSymbol
    ? flows.some((f) => f.direction === "in" && f.symbol === rewardSymbol)
    : false;
  if (emissionInflow && hasOutflows.length === 0) return "CLAIM_EMISSIONS";

  // CLAIM_FEES: inflows of non-reward tokens with no outflows (fee distributor)
  if (hasInflows.length > 0 && hasOutflows.length === 0 && !emissionInflow) {
    return "CLAIM_FEES";
  }

  // ADD_LIQUIDITY: LP minted
  if (lpMinted) return "ADD_LIQUIDITY";

  // REMOVE_LIQUIDITY: LP burned
  if (lpBurned) return "REMOVE_LIQUIDITY";

  // SWAP: inflow + outflow without LP mint/burn
  if (hasOutflows.length > 0 && hasInflows.length > 0 && !lpMinted && !lpBurned) {
    return "SWAP";
  }

  return "UNKNOWN";
}

// ---- Detect protocol from group ----

function detectProtocol(
  group: TxHashGroup,
  flows: TokenFlow[],
): "aerodrome" | "velodrome" | null {
  // Check normal tx target
  if (group.normal) {
    const result = isVeAmmRouter(group.normal.to);
    if (result) return result;
  }

  // Check ERC20 from/to for router addresses
  for (const erc20 of group.erc20s) {
    const fromResult = isVeAmmRouter(erc20.from);
    if (fromResult) return fromResult;
    const toResult = isVeAmmRouter(erc20.to);
    if (toResult) return toResult;
  }

  // Check for token symbols
  for (const flow of flows) {
    if (flow.symbol === "AERO") return "aerodrome";
    if (flow.symbol === "VELO") return "velodrome";
  }

  return null;
}

// ---- Swap description ----

function buildSwapDescription(
  flows: TokenFlow[],
  hashShort: string,
  protocolName: string,
): string {
  const outFlow = flows.find((f) => f.direction === "out");
  const inFlow = flows.find((f) => f.direction === "in");
  if (outFlow && inFlow) {
    const outStr = formatTokenAmount(outFlow.amount, outFlow.symbol);
    const inStr = formatTokenAmount(inFlow.amount, inFlow.symbol);
    return `${protocolName}: Swap ${outStr} for ${inStr} (${hashShort})`;
  }
  return `${protocolName}: Swap (${hashShort})`;
}

// ---- Handler ----

export const veAmmHandler: TransactionHandler = {
  id: "ve-amm",
  name: "ve-AMM (Aerodrome/Velodrome)",
  description:
    "Interprets Aerodrome (Base) and Velodrome (Optimism) swaps, liquidity, and reward claims",
  website: "https://aerodrome.finance",
  supportedChainIds: [8453, 10],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isVeAmmRouter(group.normal.to)) return 55;
    }

    // Check ERC20 tokens for router addresses or reward tokens
    for (const erc20 of group.erc20s) {
      if (isVeAmmRouter(erc20.from) || isVeAmmRouter(erc20.to)) return 55;
      if (erc20.tokenSymbol === "AERO" || erc20.tokenSymbol === "VELO") return 55;
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
    const protocolId = detectProtocol(group, flows);
    const protocolName = protocolId
      ? PROTOCOL_CONFIG[protocolId].name
      : "ve-AMM";
    const action = classifyAction(flows, group, protocolId);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts
    if (action === "CLAIM_EMISSIONS") {
      merged = remapCounterpartyAccounts(merged, [
        {
          from: "Equity:*:External:*",
          to: defiIncome(protocolName, "Emissions"),
        },
      ]);
    } else if (action === "CLAIM_FEES") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome(protocolName, "Fees") },
      ]);
    } else if (
      action === "ADD_LIQUIDITY" ||
      action === "REMOVE_LIQUIDITY"
    ) {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets(protocolName, "LP") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    let description: string;
    if (action === "SWAP") {
      description = buildSwapDescription(flows, hashShort, protocolName);
    } else {
      const primaryFlow = flows.find((f) =>
        action === "CLAIM_EMISSIONS" || action === "CLAIM_FEES"
          ? f.direction === "in"
          : action === "ADD_LIQUIDITY"
            ? f.direction === "out"
            : f.direction === "in",
      );
      const amountStr = primaryFlow
        ? ` ${formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)}`
        : "";
      description = `${protocolName}: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "ve-amm",
      "handler:action": action,
    };
    if (protocolId) {
      metadata["handler:protocol"] = protocolId;
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: {
        type: "defi",
        protocol: protocolName,
        action: ACTION_LABELS[action],
        chain: ctx.chain.name,
        txHash: group.hash,
      },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: LP tokens should not have exchange rates
    const currencyHints: Record<string, null> = {};
    for (const item of allItems) {
      if (isLpToken(item.currency)) {
        currencyHints[item.currency] = null;
      }
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
