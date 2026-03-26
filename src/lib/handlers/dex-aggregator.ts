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
import { isAggregator } from "./addresses.js";

const PROTOCOL_NAMES: Record<string, string> = {
  "1inch": "1inch",
  "0x": "0x",
  cow: "CoW Protocol",
  paraswap: "Paraswap",
  odos: "Odos",
  openocean: "OpenOcean",
  firebird: "Firebird",
};

export const dexAggregatorHandler: TransactionHandler = {
  id: "dex-aggregator",
  name: "DEX Aggregator",
  description: "Interprets swaps through DEX aggregators (1inch, 0x, CoW Protocol, Paraswap, Odos, OpenOcean, Firebird)",
  supportedChainIds: [1, 42161, 10, 137, 8453, 56, 43114, 100, 250, 1284],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    if (!group.normal) return 0;
    const agg = isAggregator(group.normal.to);
    return agg ? 50 : 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const protocolKey = group.normal ? isAggregator(group.normal.to) : null;
    const protocolName = protocolKey ? (PROTOCOL_NAMES[protocolKey] ?? protocolKey) : "DEX Aggregator";

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const outflow = flows.find((f) => f.direction === "out");
    const inflow = flows.find((f) => f.direction === "in");

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    let description: string;
    if (outflow && inflow) {
      description = `${protocolName}: Swap ${formatTokenAmount(outflow.amount, outflow.symbol)} for ${formatTokenAmount(inflow.amount, inflow.symbol)} (${hashShort})`;
    } else if (outflow) {
      description = `${protocolName}: Swap ${formatTokenAmount(outflow.amount, outflow.symbol)} (${hashShort})`;
    } else if (inflow) {
      description = `${protocolName}: Swap for ${formatTokenAmount(inflow.amount, inflow.symbol)} (${hashShort})`;
    } else {
      description = `${protocolName}: Swap (${hashShort})`;
    }

    const metadata: Record<string, string> = {
      handler: "dex-aggregator",
      "handler:action": "SWAP",
      "handler:protocol": protocolKey ?? "unknown",
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: protocolName, action: "swap", chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
