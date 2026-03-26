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
import { isBridgeContract } from "./addresses.js";

// ---- Action classification ----

type BridgeAction = "BRIDGE_DEPOSIT" | "BRIDGE_FILL";

const PROTOCOL_NAMES: Record<string, string> = {
  across: "Across",
  stargate: "Stargate",
  hop: "Hop",
  cctp: "Circle CCTP",
};

function classifyAction(
  group: TxHashGroup,
  addr: string,
): BridgeAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);
  const hasOutflows = flows.some((f) => f.direction === "out");
  const hasInflows = flows.some((f) => f.direction === "in");

  if (hasOutflows) return "BRIDGE_DEPOSIT";
  if (hasInflows) return "BRIDGE_FILL";

  // Fallback: check native value direction
  if (group.normal) {
    const from = group.normal.from.toLowerCase();
    if (from === addr) return "BRIDGE_DEPOSIT";
  }

  return "BRIDGE_FILL";
}

// ---- Handler ----

export const bridgeHandler: TransactionHandler = {
  id: "bridge",
  name: "Cross-Chain Bridge",
  description: "Interprets cross-chain bridge transactions (Across, Stargate, Hop, Circle CCTP)",
  supportedChainIds: [1, 42161, 10, 137, 8453, 100, 43114],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    if (!group.normal) return 0;
    const to = group.normal.to.toLowerCase();
    const protocol = isBridgeContract(to, ctx.chainId);
    return protocol ? 50 : 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const protocol = isBridgeContract(group.normal!.to.toLowerCase(), ctx.chainId)!;
    const protocolName = PROTOCOL_NAMES[protocol] ?? protocol;
    const action = classifyAction(group, addr);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description from primary flow token
    const flows = analyzeErc20Flows(group.erc20s, addr);
    let description: string;

    if (action === "BRIDGE_DEPOSIT") {
      const outflow = flows.find((f) => f.direction === "out");
      const tokenStr = outflow
        ? formatTokenAmount(outflow.amount, outflow.symbol)
        : ctx.chain.native_currency;
      description = `${protocolName}: Bridge ${tokenStr} (${hashShort})`;
    } else {
      const inflow = flows.find((f) => f.direction === "in");
      const tokenStr = inflow
        ? formatTokenAmount(inflow.amount, inflow.symbol)
        : ctx.chain.native_currency;
      description = `${protocolName}: Receive ${tokenStr} (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "bridge",
      "handler:action": action,
      "handler:protocol": protocol,
    };

    const bridgeAction = action === "BRIDGE_DEPOSIT" ? "bridge" : "receive";
    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: protocolName, action: bridgeAction, chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
