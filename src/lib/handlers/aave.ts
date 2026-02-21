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
import { AAVE, isAavePool, ZERO_ADDRESS } from "./addresses.js";
import { getDefiLlamaPools, findPool } from "./defillama-yields.js";

// ---- Token detection ----

function isAToken(symbol: string): boolean {
  return /^a(Eth|Arb|Opt|Bas|Pol)?[A-Z]/.test(symbol);
}

function isDebtToken(symbol: string): boolean {
  return /^(variable|stable)Debt/.test(symbol);
}

// ---- Action classification ----

type AaveAction =
  | "SUPPLY"
  | "WITHDRAW"
  | "BORROW"
  | "REPAY"
  | "DEPOSIT_ETH"
  | "WITHDRAW_ETH"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): AaveAction {
  const aTokenMinted = flows.some((f) => f.isMint && isAToken(f.symbol));
  const aTokenBurned = flows.some((f) => f.isBurn && isAToken(f.symbol));
  const debtMinted = flows.some((f) => f.isMint && isDebtToken(f.symbol));
  const debtBurned = flows.some((f) => f.isBurn && isDebtToken(f.symbol));

  // DEPOSIT_ETH: normal tx value > 0 to WrappedTokenGateway + aWETH minted
  if (
    group.normal &&
    group.normal.value !== "0" &&
    group.normal.to.toLowerCase() === AAVE.WRAPPED_TOKEN_GATEWAY &&
    aTokenMinted
  ) {
    return "DEPOSIT_ETH";
  }

  // WITHDRAW_ETH: aToken burned + internal tx ETH to user
  if (aTokenBurned) {
    const hasEthInternal = group.internals.some(
      (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
    );
    if (hasEthInternal) return "WITHDRAW_ETH";
  }

  // SUPPLY: aToken minted + underlying outflow
  if (aTokenMinted) {
    const hasUnderlyingOut = flows.some(
      (f) => f.direction === "out" && !isAToken(f.symbol) && !isDebtToken(f.symbol),
    );
    if (hasUnderlyingOut) return "SUPPLY";
  }

  // WITHDRAW: aToken burned + underlying inflow
  if (aTokenBurned) {
    const hasUnderlyingIn = flows.some(
      (f) => f.direction === "in" && !isAToken(f.symbol) && !isDebtToken(f.symbol),
    );
    if (hasUnderlyingIn) return "WITHDRAW";
  }

  // BORROW: debtToken minted + underlying inflow
  if (debtMinted) {
    const hasUnderlyingIn = flows.some(
      (f) => f.direction === "in" && !isAToken(f.symbol) && !isDebtToken(f.symbol),
    );
    if (hasUnderlyingIn) return "BORROW";
  }

  // REPAY: debtToken burned + underlying outflow
  if (debtBurned) {
    const hasUnderlyingOut = flows.some(
      (f) => f.direction === "out" && !isAToken(f.symbol) && !isDebtToken(f.symbol),
    );
    if (hasUnderlyingOut) return "REPAY";
  }

  // CLAIM_REWARDS: only inflows, no aToken/debtToken mints/burns
  if (!aTokenMinted && !aTokenBurned && !debtMinted && !debtBurned) {
    const hasInflows = flows.some((f) => f.direction === "in");
    const hasOutflows = flows.some((f) => f.direction === "out");
    if (hasInflows && !hasOutflows) return "CLAIM_REWARDS";
  }

  return "UNKNOWN";
}

// ---- Action labels ----

const ACTION_LABELS: Record<AaveAction, string> = {
  SUPPLY: "Supply",
  WITHDRAW: "Withdraw",
  BORROW: "Borrow",
  REPAY: "Repay",
  DEPOSIT_ETH: "Deposit ETH",
  WITHDRAW_ETH: "Withdraw ETH",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

// ---- Find underlying token flow ----

function findUnderlyingFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find(
    (f) => !isAToken(f.symbol) && !isDebtToken(f.symbol),
  );
}

// ---- Enrichment via DefiLlama ----

interface AaveEnrichment {
  supply_apy: string;
  borrow_apy: string;
}

async function fetchAaveEnrichment(
  underlyingSymbol: string,
  chainId: number,
): Promise<AaveEnrichment | null> {
  const pools = await getDefiLlamaPools();
  const result =
    findPool(pools, "aave-v3", underlyingSymbol, chainId) ??
    findPool(pools, "aave-v2", underlyingSymbol, chainId);
  if (!result) return null;

  return {
    supply_apy: result.apyBase,
    borrow_apy: result.apyBaseBorrow,
  };
}

// ---- Handler ----

export const aaveHandler: TransactionHandler = {
  id: "aave",
  name: "Aave",
  description: "Interprets Aave lending/borrowing transactions",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (isAavePool(to, ctx.chainId)) return 55;
      if (to === AAVE.WRAPPED_TOKEN_GATEWAY) return 55;
    }

    for (const erc20 of group.erc20s) {
      if (isAToken(erc20.tokenSymbol) || isDebtToken(erc20.tokenSymbol)) {
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
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(flows, group, addr);

    // Ensure native currency for item building
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts based on action
    if (action === "BORROW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Liabilities:Aave:Borrow" },
      ]);
    } else if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Income:Aave:Rewards" },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description with underlying token amount
    const underlying = findUnderlyingFlow(flows);
    const amountStr = underlying
      ? ` ${formatTokenAmount(underlying.amount, underlying.symbol)}`
      : "";
    const description = `Aave: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    // Determine version
    const isV2 = group.normal
      ? group.normal.to.toLowerCase() === AAVE.V2_POOL
      : false;
    const version = isV2 ? "V2" : "V3";

    const metadata: Record<string, string> = {
      handler: "aave",
      "handler:action": action,
      "handler:version": version,
    };

    // Enrichment: fetch APY data from Aave API (opt-in)
    if (ctx.enrichment && underlying) {
      try {
        const enrichment = await fetchAaveEnrichment(underlying.symbol, ctx.chainId);
        if (enrichment) {
          metadata["handler:supply_apy"] = enrichment.supply_apy;
          metadata["handler:borrow_apy"] = enrichment.borrow_apy;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Aave enrichment failed: ${msg}`;
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

    // Currency hints: aTokens and debtTokens should not be auto-priced
    const protocolTokens = allItems
      .map((i) => i.currency)
      .filter((c) => isAToken(c) || isDebtToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of protocolTokens) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
