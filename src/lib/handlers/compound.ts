import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
  Erc20Tx,
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
} from "./item-builder.js";
import { ZERO_ADDRESS, isCompoundContract } from "./addresses.js";

// ---- Token detection ----

function isCToken(symbol: string): boolean {
  return /^c[A-Z]/.test(symbol);
}

function isCTokenV3(symbol: string): boolean {
  return /^c[A-Z]+v3$/.test(symbol);
}

// ---- Action classification ----

type CompoundAction = "SUPPLY" | "WITHDRAW" | "BORROW" | "REPAY" | "CLAIM_COMP" | "UNKNOWN";

const ACTION_LABELS: Record<CompoundAction, string> = {
  SUPPLY: "Supply",
  WITHDRAW: "Withdraw",
  BORROW: "Borrow",
  REPAY: "Repay",
  CLAIM_COMP: "Claim COMP",
  UNKNOWN: "Interact with",
};

function classifyAction(erc20s: Erc20Tx[], addr: string): CompoundAction {
  const flows = analyzeErc20Flows(erc20s, addr);

  const cTokenMinted = flows.some((f) => isCToken(f.symbol) && f.isMint);
  const cTokenBurned = flows.some((f) => isCToken(f.symbol) && f.isBurn);
  const compInflow = flows.some(
    (f) => f.symbol === "COMP" && f.direction === "in",
  );
  const hasNonCompOutflow = flows.some(
    (f) => f.direction === "out" && f.symbol !== "COMP" && !isCToken(f.symbol),
  );
  const hasNonCompInflow = flows.some(
    (f) => f.direction === "in" && f.symbol !== "COMP" && !isCToken(f.symbol),
  );

  if (cTokenMinted) return "SUPPLY";
  if (cTokenBurned) return "WITHDRAW";
  if (compInflow && !hasNonCompOutflow) return "CLAIM_COMP";
  if (hasNonCompInflow && !cTokenMinted && !cTokenBurned) return "BORROW";
  if (hasNonCompOutflow && !cTokenMinted && !cTokenBurned) return "REPAY";

  return "UNKNOWN";
}

// ---- Find underlying token for description ----

function findUnderlyingFlow(
  erc20s: Erc20Tx[],
  addr: string,
): { symbol: string; amount: import("decimal.js-light").default } | null {
  const flows = analyzeErc20Flows(erc20s, addr);
  for (const flow of flows) {
    if (!isCToken(flow.symbol) && flow.symbol !== "COMP") {
      return { symbol: flow.symbol, amount: flow.amount };
    }
  }
  return null;
}

// ---- Enrichment via DefiLlama ----

import { getDefiLlamaPools, findPool } from "./defillama-yields.js";

async function fetchCompoundEnrichment(
  underlyingSymbol: string,
  chainId: number,
): Promise<{ supply_apy: string; borrow_apy: string } | null> {
  const pools = await getDefiLlamaPools();
  // Try V3 first, fall back to V2
  const result =
    findPool(pools, "compound-v3", underlyingSymbol, chainId) ??
    findPool(pools, "compound-v2", underlyingSymbol, chainId);
  if (!result) return null;
  return {
    supply_apy: result.apyBase,
    borrow_apy: result.apyBaseBorrow,
  };
}

// ---- Handler ----

export const compoundHandler: TransactionHandler = {
  id: "compound",
  name: "Compound Finance",
  description: "Interprets Compound lending/borrowing transactions",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    for (const erc20 of group.erc20s) {
      if (isCToken(erc20.tokenSymbol)) return 55;
    }

    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (isCompoundContract(to, ctx.chainId)) return 55;
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

    const action = classifyAction(group.erc20s, addr);

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
    if (action === "BORROW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Liabilities:Compound:Borrow" },
      ]);
    } else if (action === "CLAIM_COMP") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Income:Compound:Rewards" },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const underlying = findUnderlyingFlow(group.erc20s, addr);
    const actionLabel = ACTION_LABELS[action];
    const amountStr = underlying
      ? formatTokenAmount(underlying.amount, underlying.symbol)
      : "";
    const description = amountStr
      ? `Compound: ${actionLabel} ${amountStr} (${hashShort})`
      : `Compound: ${actionLabel} (${hashShort})`;

    // Determine version
    const hasCTokenV3 = group.erc20s.some((tx) => isCTokenV3(tx.tokenSymbol));
    const version = hasCTokenV3 ? "V3" : "V2";

    // Find cToken symbol
    const cTokenSymbol =
      group.erc20s.find((tx) => isCToken(tx.tokenSymbol))?.tokenSymbol ?? "";

    const metadata: Record<string, string> = {
      handler: "compound",
      "handler:action": action,
      "handler:version": version,
      "handler:ctoken": cTokenSymbol,
    };

    // Enrichment: fetch APY data from DefiLlama (opt-in)
    if (ctx.enrichment && action !== "CLAIM_COMP" && underlying) {
      try {
        const enrichment = await fetchCompoundEnrichment(underlying.symbol, ctx.chainId);
        if (enrichment) {
          metadata["handler:supply_apy"] = enrichment.supply_apy;
          metadata["handler:borrow_apy"] = enrichment.borrow_apy;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Compound enrichment failed: ${msg}`;
      }
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
    });

    // Currency hints: cTokens should not fetch exchange rates
    const cTokenCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isCToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of cTokenCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
