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
  buildGroupDescription,
  buildHandlerEntry,
} from "./item-builder.js";

export const GenericEtherscanHandler: TransactionHandler = {
  id: "generic-etherscan",
  name: "Generic Etherscan",
  description: "Default handler for all blockchain transactions",
  supportedChainIds: [],

  match(_group: TxHashGroup, _ctx: HandlerContext): number {
    return 1;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    if (group.normal && group.normal.isError === "1") {
      return { type: "skip", reason: "failed transaction" };
    }

    const date = timestampToDate(group.timestamp);
    const addr = ctx.address;
    const chain = ctx.chain;

    const allItems = await buildAllGroupItems(group, addr, chain, ctx.label, ctx);
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const items = await resolveToLineItems(merged, date, ctx);
    const description = buildGroupDescription(group, addr, chain);

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items,
      metadata: { handler: "generic-etherscan" },
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
