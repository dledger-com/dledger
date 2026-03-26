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
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  formatTokenAmount,
} from "./item-builder.js";
import {
  ZERO_ADDRESS,
  isLiquidStakingToken,
  isLiquidStakingContract,
  LIQUID_STAKING,
} from "./addresses.js";
import { defiAssets } from "../accounts/paths.js";

// ---- Action classification ----

type LiquidStakingAction = "STAKE" | "UNSTAKE" | "WRAP" | "UNWRAP" | "UNKNOWN";

const ACTION_LABELS: Record<LiquidStakingAction, string> = {
  STAKE: "Stake",
  UNSTAKE: "Unstake",
  WRAP: "Wrap",
  UNWRAP: "Unwrap",
  UNKNOWN: "Interact",
};

/** Detect which protocol is involved via ERC-20 symbols or contract addresses */
function detectProtocol(
  group: TxHashGroup,
  _addr: string,
): { protocolId: string; protocolName: string } | null {
  // Check ERC-20 token symbols first
  for (const erc20 of group.erc20s) {
    const id = isLiquidStakingToken(erc20.tokenSymbol);
    if (id) return { protocolId: id, protocolName: LIQUID_STAKING[id].name };
  }

  // Check normal.to contract
  if (group.normal) {
    const id = isLiquidStakingContract(group.normal.to);
    if (id) return { protocolId: id, protocolName: LIQUID_STAKING[id].name };
  }

  return null;
}

function classifyAction(
  group: TxHashGroup,
  addr: string,
  protocolId: string,
): LiquidStakingAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);
  const protocolTokens = new Set(
    (LIQUID_STAKING[protocolId].tokens as unknown as string[]).map((t) => t.toUpperCase()),
  );

  const lstInflows = flows.filter(
    (f) => f.direction === "in" && protocolTokens.has(f.symbol.toUpperCase()),
  );
  const lstOutflows = flows.filter(
    (f) => f.direction === "out" && protocolTokens.has(f.symbol.toUpperCase()),
  );

  // STAKE: LST minted from 0x0 (or received from contract) with no LST outflow
  const hasMintedLst = lstInflows.some((f) => f.isMint);
  if (hasMintedLst && lstOutflows.length === 0) return "STAKE";

  // UNSTAKE: LST burned to 0x0 (or sent to contract) with no LST inflow
  const hasBurnedLst = lstOutflows.some((f) => f.isBurn);
  if (hasBurnedLst && lstInflows.length === 0) return "UNSTAKE";

  // WRAP/UNWRAP: Two different LSTs from the same protocol involved
  if (lstInflows.length > 0 && lstOutflows.length > 0) {
    const inSymbol = lstInflows[0].symbol.toUpperCase();
    const outSymbol = lstOutflows[0].symbol.toUpperCase();
    if (inSymbol !== outSymbol) {
      // Convention: if the inflow is the "wrapped" variant, it's WRAP; otherwise UNWRAP
      // Wrapped variants typically have a "W" prefix (WEETH, WSTETH) or "S" prefix (SFRXETH, SUSDE)
      const wrappedPatterns = /^(W|S(?!W))/;
      if (wrappedPatterns.test(inSymbol)) return "WRAP";
      return "UNWRAP";
    }
  }

  // Fallback: LST inflow without mint → likely STAKE via swap
  if (lstInflows.length > 0 && lstOutflows.length === 0) return "STAKE";
  if (lstOutflows.length > 0 && lstInflows.length === 0) return "UNSTAKE";

  return "UNKNOWN";
}

// ---- Handler ----

export const liquidStakingHandler: TransactionHandler = {
  id: "liquid-staking",
  name: "Liquid Staking",
  description:
    "Interprets liquid staking transactions (Rocket Pool, ether.fi, Kelp, Renzo, Swell, StakeWise, Frax Ether, Ethena)",
  supportedChainIds: [1],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check ERC-20 token symbols
    for (const erc20 of group.erc20s) {
      if (isLiquidStakingToken(erc20.tokenSymbol)) return 55;
    }

    // Check normal.to contract address
    if (group.normal) {
      if (isLiquidStakingContract(group.normal.to)) return 55;
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

    const detected = detectProtocol(group, addr);
    if (!detected) {
      return { type: "skip", reason: "no liquid staking protocol detected" };
    }
    const { protocolId, protocolName } = detected;

    const action = classifyAction(group, addr, protocolId);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    // Override account path for LST positions to use the protocol's DeFi account
    const stakingAccount = defiAssets(protocolName, "Staking");
    for (const item of merged) {
      const protocolTokens = new Set(
        (LIQUID_STAKING[protocolId].tokens as unknown as string[]).map((t) => t.toUpperCase()),
      );
      if (protocolTokens.has(item.currency.toUpperCase())) {
        item.account = stakingAccount;
      }
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description from primary flow token
    const flows = analyzeErc20Flows(group.erc20s, addr);
    const primaryFlow =
      flows.find((f) => f.direction === "in") ?? flows.find((f) => f.direction === "out");
    const tokenStr = primaryFlow
      ? formatTokenAmount(primaryFlow.amount, primaryFlow.symbol)
      : "";

    const description = tokenStr
      ? `${protocolName}: ${ACTION_LABELS[action]} ${tokenStr} (${hashShort})`
      : `${protocolName}: ${ACTION_LABELS[action]} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "liquid-staking",
      "handler:action": action,
      "handler:protocol": protocolId,
    };

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

    return { type: "entries", entries: [handlerEntry] };
  },
};
