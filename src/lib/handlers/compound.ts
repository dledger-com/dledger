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
import { defiLiabilities, defiIncome } from "../accounts/paths.js";

// ---- Protocol detection ----

type CompoundProtocol = "Compound" | "Venus";

function detectProtocol(chainId: number): CompoundProtocol {
  return chainId === 56 ? "Venus" : "Compound";
}

// ---- Token detection ----

function isCToken(symbol: string): boolean {
  return /^c[A-Z]/.test(symbol);
}

function isVToken(symbol: string): boolean {
  return /^v[A-Z]/.test(symbol);
}

function isProtocolToken(symbol: string, protocol: CompoundProtocol): boolean {
  return protocol === "Venus" ? isVToken(symbol) : isCToken(symbol);
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

/** Reward token for the given protocol */
function rewardToken(protocol: CompoundProtocol): string {
  return protocol === "Venus" ? "XVS" : "COMP";
}

function classifyAction(erc20s: Erc20Tx[], addr: string, protocol: CompoundProtocol): CompoundAction {
  const flows = analyzeErc20Flows(erc20s, addr);
  const reward = rewardToken(protocol);
  const isProtoToken = (s: string) => isProtocolToken(s, protocol);

  const protoTokenMinted = flows.some((f) => isProtoToken(f.symbol) && f.isMint);
  const protoTokenBurned = flows.some((f) => isProtoToken(f.symbol) && f.isBurn);
  const rewardInflow = flows.some(
    (f) => f.symbol === reward && f.direction === "in",
  );
  const hasNonRewardOutflow = flows.some(
    (f) => f.direction === "out" && f.symbol !== reward && !isProtoToken(f.symbol),
  );
  const hasNonRewardInflow = flows.some(
    (f) => f.direction === "in" && f.symbol !== reward && !isProtoToken(f.symbol),
  );

  if (protoTokenMinted) return "SUPPLY";
  if (protoTokenBurned) return "WITHDRAW";
  if (rewardInflow && !hasNonRewardOutflow) return "CLAIM_COMP";
  if (hasNonRewardInflow && !protoTokenMinted && !protoTokenBurned) return "BORROW";
  if (hasNonRewardOutflow && !protoTokenMinted && !protoTokenBurned) return "REPAY";

  return "UNKNOWN";
}

// ---- Find underlying token for description ----

function findUnderlyingFlow(
  erc20s: Erc20Tx[],
  addr: string,
  protocol: CompoundProtocol,
): { symbol: string; amount: import("decimal.js-light").default } | null {
  const flows = analyzeErc20Flows(erc20s, addr);
  const reward = rewardToken(protocol);
  for (const flow of flows) {
    if (!isProtocolToken(flow.symbol, protocol) && flow.symbol !== reward) {
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
  website: "https://compound.finance",
  supportedChainIds: [1, 42161, 10, 137, 8453, 56],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    const protocol = detectProtocol(ctx.chainId);
    for (const erc20 of group.erc20s) {
      if (isProtocolToken(erc20.tokenSymbol, protocol)) return 55;
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

    const protocol = detectProtocol(ctx.chainId);
    const protocolName = protocol as string;
    const action = classifyAction(group.erc20s, addr, protocol);

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
        { from: "Equity:*:External:*", to: defiLiabilities(protocolName, "Borrow") },
      ]);
    } else if (action === "CLAIM_COMP") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome(protocolName, "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const underlying = findUnderlyingFlow(group.erc20s, addr, protocol);
    const actionLabel = ACTION_LABELS[action];
    const amountStr = underlying
      ? formatTokenAmount(underlying.amount, underlying.symbol)
      : "";
    const description = amountStr
      ? `${protocolName}: ${actionLabel} ${amountStr} (${hashShort})`
      : `${protocolName}: ${actionLabel} (${hashShort})`;

    // Determine version
    const hasCTokenV3 = group.erc20s.some((tx) => isCTokenV3(tx.tokenSymbol));
    const version = hasCTokenV3 ? "V3" : "V2";

    // Find protocol token symbol (cToken or vToken)
    const protoTokenSymbol =
      group.erc20s.find((tx) => isProtocolToken(tx.tokenSymbol, protocol))?.tokenSymbol ?? "";

    const metadata: Record<string, string> = {
      handler: "compound",
      "handler:action": action,
      "handler:version": version,
      "handler:ctoken": protoTokenSymbol,
    };

    if (protocol !== "Compound") {
      metadata["handler:protocol"] = protocolName;
    }

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
      descriptionData: { type: "defi", protocol: protocolName, action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: protocol tokens (cTokens/vTokens) should not fetch exchange rates
    const cTokenCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isProtocolToken(c, protocol))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of cTokenCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
