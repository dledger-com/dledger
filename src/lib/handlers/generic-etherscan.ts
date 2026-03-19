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
  analyzeErc20Flows,
} from "./item-builder.js";
import type { DescriptionData } from "../types/index.js";
import { shortAddr } from "../browser-etherscan.js";

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

    // Build descriptionData based on transaction type
    let descriptionData: DescriptionData;
    const tokenCount = group.erc20s.length + group.erc721s.length + group.erc1155s.length;

    if (group.normal) {
      const from = group.normal.from.toLowerCase();
      const to = group.normal.to.toLowerCase();
      const symbol = chain.native_currency;

      if (from === addr && to === addr) {
        descriptionData = { type: "onchain-transfer", chain: chain.name, currency: symbol, direction: "self", txHash: group.hash };
      } else if (!to) {
        descriptionData = { type: "onchain-contract", chain: chain.name, currency: symbol, action: "creation", txHash: group.hash };
      } else if (from === addr) {
        descriptionData = { type: "onchain-transfer", chain: chain.name, currency: symbol, direction: "sent", counterparty: shortAddr(to), txHash: group.hash, ...(tokenCount > 0 ? { tokenCount } : {}) };
      } else {
        descriptionData = { type: "onchain-transfer", chain: chain.name, currency: symbol, direction: "received", counterparty: shortAddr(from), txHash: group.hash, ...(tokenCount > 0 ? { tokenCount } : {}) };
      }
    } else if (group.internals.length > 0 && tokenCount === 0) {
      descriptionData = { type: "onchain-contract", chain: chain.name, currency: chain.native_currency, action: "internal-transfer", txHash: group.hash };
    } else {
      // ERC20/721/1155 only
      const flows = analyzeErc20Flows(group.erc20s, addr);
      const mainFlow = flows[0];
      const mainSymbol = mainFlow?.symbol ?? chain.native_currency;
      const direction: "sent" | "received" | "self" = mainFlow
        ? mainFlow.direction === "out" ? "sent" : "received"
        : "received";
      const counterparty = mainFlow
        ? mainFlow.direction === "out" ? shortAddr(mainFlow.to) : shortAddr(mainFlow.from)
        : undefined;
      descriptionData = { type: "onchain-transfer", chain: chain.name, currency: mainSymbol, direction, counterparty, txHash: group.hash, ...(flows.length > 1 ? { tokenCount: flows.length } : {}) };
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData,
      chainId: ctx.chainId,
      hash: group.hash,
      items,
      metadata: { handler: "generic-etherscan" },
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
