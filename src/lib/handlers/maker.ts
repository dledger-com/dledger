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
import { MAKER, isMakerContract, ZERO_ADDRESS } from "./addresses.js";

// ---- Token detection ----

function isSpToken(symbol: string): boolean {
  return /^sp[A-Z]/.test(symbol);
}

function isSdai(symbol: string): boolean {
  return symbol === "sDAI";
}

function isMakerProtocolToken(symbol: string): boolean {
  return isSpToken(symbol) || isSdai(symbol);
}

// ---- Action classification ----

type MakerAction =
  | "SDAI_WRAP"
  | "SDAI_UNWRAP"
  | "SPARK_SUPPLY"
  | "SPARK_WITHDRAW"
  | "SPARK_BORROW"
  | "UNKNOWN";

const ACTION_LABELS: Record<MakerAction, string> = {
  SDAI_WRAP: "Wrap DAI to sDAI",
  SDAI_UNWRAP: "Unwrap sDAI to DAI",
  SPARK_SUPPLY: "Supply",
  SPARK_WITHDRAW: "Withdraw",
  SPARK_BORROW: "Borrow",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): MakerAction {
  const sdaiMinted = flows.some((f) => isSdai(f.symbol) && f.isMint);
  const sdaiBurned = flows.some((f) => isSdai(f.symbol) && f.isBurn);
  const sdaiIn = flows.some((f) => isSdai(f.symbol) && f.direction === "in");
  const sdaiOut = flows.some((f) => isSdai(f.symbol) && f.direction === "out");
  const daiOut = flows.some((f) => f.symbol === "DAI" && f.direction === "out");
  const daiIn = flows.some((f) => f.symbol === "DAI" && f.direction === "in");

  const spTokenMinted = flows.some((f) => isSpToken(f.symbol) && f.isMint);
  const spTokenBurned = flows.some((f) => isSpToken(f.symbol) && f.isBurn);

  const hasNonProtocolInflow = flows.some(
    (f) => f.direction === "in" && !isMakerProtocolToken(f.symbol),
  );
  const hasNonProtocolOutflow = flows.some(
    (f) => f.direction === "out" && !isMakerProtocolToken(f.symbol),
  );

  // SDAI_WRAP: DAI outflow + sDAI minted/inflow
  if (daiOut && (sdaiMinted || sdaiIn)) return "SDAI_WRAP";

  // SDAI_UNWRAP: sDAI burned/outflow + DAI inflow
  if ((sdaiBurned || sdaiOut) && daiIn) return "SDAI_UNWRAP";

  // SPARK_SUPPLY: spToken minted + underlying outflow
  if (spTokenMinted && hasNonProtocolOutflow) return "SPARK_SUPPLY";

  // SPARK_WITHDRAW: spToken burned + underlying inflow
  if (spTokenBurned && hasNonProtocolInflow) return "SPARK_WITHDRAW";

  // SPARK_BORROW: non-protocol inflow without spToken mints/burns
  if (!spTokenMinted && !spTokenBurned && hasNonProtocolInflow && !hasNonProtocolOutflow) {
    return "SPARK_BORROW";
  }

  return "UNKNOWN";
}

// ---- Find underlying token flow ----

function findUnderlyingFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find((f) => !isMakerProtocolToken(f.symbol));
}

// ---- Enrichment via DefiLlama (Spark only) ----

import { getDefiLlamaPools, findPool } from "./defillama-yields.js";

async function fetchSparkEnrichment(
  underlyingSymbol: string,
  chainId: number,
): Promise<{ supply_apy: string; borrow_apy: string } | null> {
  const pools = await getDefiLlamaPools();
  const result = findPool(pools, "spark", underlyingSymbol, chainId);
  if (!result) return null;
  return {
    supply_apy: result.apyBase,
    borrow_apy: result.apyBaseBorrow,
  };
}

// ---- Handler ----

export const makerHandler: TransactionHandler = {
  id: "maker",
  name: "MakerDAO/Spark",
  description: "Interprets MakerDAO sDAI and Spark lending transactions",
  supportedChainIds: [1],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check ERC20 symbols for sDAI or spTokens
    for (const erc20 of group.erc20s) {
      if (isSdai(erc20.tokenSymbol) || isSpToken(erc20.tokenSymbol)) {
        return 55;
      }
    }

    // Check normal tx target
    if (group.normal) {
      if (isMakerContract(group.normal.to)) return 55;
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
    const action = classifyAction(flows, group, addr);

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
    if (action === "SPARK_BORROW") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: "Liabilities:Spark:Borrow" },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const underlying = findUnderlyingFlow(flows);
    const amountStr = underlying
      ? ` ${formatTokenAmount(underlying.amount, underlying.symbol)}`
      : "";
    const description = `MakerDAO/Spark: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "maker",
      "handler:action": action,
    };

    // Find protocol token symbol for metadata
    const protocolTokenSymbol =
      group.erc20s.find((tx) => isMakerProtocolToken(tx.tokenSymbol))?.tokenSymbol ?? "";
    if (protocolTokenSymbol) {
      metadata["handler:protocol_token"] = protocolTokenSymbol;
    }

    // Enrichment: fetch Spark APY from DefiLlama (opt-in, Spark actions only)
    const isSparkAction = action === "SPARK_SUPPLY" || action === "SPARK_WITHDRAW" || action === "SPARK_BORROW";
    if (ctx.enrichment && isSparkAction && underlying) {
      try {
        const enrichment = await fetchSparkEnrichment(underlying.symbol, ctx.chainId);
        if (enrichment) {
          metadata["handler:supply_apy"] = enrichment.supply_apy;
          metadata["handler:borrow_apy"] = enrichment.borrow_apy;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Spark enrichment failed: ${msg}`;
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

    // Currency hints: sDAI and spTokens should not fetch exchange rates
    const protocolCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isMakerProtocolToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of protocolCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
