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
  type TokenFlow,
} from "./item-builder.js";
import { ZERO_ADDRESS, isYearnContract } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";
import { renderDescription } from "../types/description-data.js";

// ---- Token detection ----

function isYvToken(symbol: string): boolean {
  return /^yv[A-Z]/.test(symbol);
}

// ---- Action classification ----

type YearnAction = "DEPOSIT" | "WITHDRAW" | "HARVEST_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<YearnAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  HARVEST_REWARDS: "Harvest Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(flows: TokenFlow[]): YearnAction {
  const yvMinted = flows.some((f) => isYvToken(f.symbol) && f.isMint);
  const yvBurned = flows.some((f) => isYvToken(f.symbol) && f.isBurn);
  const hasNonYvInflow = flows.some(
    (f) => f.direction === "in" && !isYvToken(f.symbol),
  );
  const hasNonYvOutflow = flows.some(
    (f) => f.direction === "out" && !isYvToken(f.symbol),
  );

  // DEPOSIT: yvToken minted + underlying outflow
  if (yvMinted && hasNonYvOutflow) return "DEPOSIT";

  // WITHDRAW: yvToken burned + underlying inflow
  if (yvBurned && hasNonYvInflow) return "WITHDRAW";

  // HARVEST_REWARDS: only inflows, no yvToken mints/burns
  if (!yvMinted && !yvBurned && hasNonYvInflow && !hasNonYvOutflow) {
    return "HARVEST_REWARDS";
  }

  return "UNKNOWN";
}

// ---- Find underlying token flow ----

function findUnderlyingFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find((f) => !isYvToken(f.symbol));
}

// ---- Enrichment via yDaemon API ----

interface YearnEnrichment {
  vault_apy: string;
  vault_tvl_usd: string;
}

const YEARN_CHAIN_IDS: Record<number, string> = {
  1: "1",
  42161: "42161",
  10: "10",
  137: "137",
};

async function fetchYearnEnrichment(
  vaultAddress: string,
  chainId: number,
): Promise<YearnEnrichment | null> {
  const chain = YEARN_CHAIN_IDS[chainId];
  if (!chain) return null;

  const resp = await fetch(
    `https://ydaemon.yearn.fi/${chain}/vaults/${vaultAddress}`,
  );
  if (!resp.ok) return null;

  const data = await resp.json();
  const apy =
    data?.apr?.forwardAPR?.netAPR ?? data?.apr?.netAPR ?? null;
  const tvl = data?.tvl?.tvl ?? null;

  if (apy == null) return null;

  return {
    vault_apy: apy.toString(),
    vault_tvl_usd: tvl != null ? tvl.toString() : "",
  };
}

// ---- Handler ----

export const yearnHandler: TransactionHandler = {
  id: "yearn",
  name: "Yearn Finance",
  description: "Interprets Yearn vault deposit/withdraw transactions",
  website: "https://yearn.fi",
  supportedChainIds: [1, 42161, 10, 137],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check ERC20 symbols for yvTokens
    for (const erc20 of group.erc20s) {
      if (isYvToken(erc20.tokenSymbol)) return 55;
    }

    // Check normal tx target
    if (group.normal) {
      if (isYearnContract(group.normal.to)) return 55;
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(flows);

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
    if (action === "HARVEST_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Yearn", "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const summary = `Yearn (${ctx.chain.name}): ${ACTION_LABELS[action]}`;

    const metadata: Record<string, string> = {
      handler: "yearn",
      "handler:action": action,
    };

    // Find yvToken symbol and address for metadata + enrichment
    const yvTokenTx = group.erc20s.find((tx) => isYvToken(tx.tokenSymbol));
    if (yvTokenTx) {
      metadata["handler:vault_token"] = yvTokenTx.tokenSymbol;
    }

    // Enrichment: fetch vault APY from yDaemon API (opt-in)
    if (ctx.enrichment && (action === "DEPOSIT" || action === "WITHDRAW") && yvTokenTx) {
      try {
        const enrichment = await fetchYearnEnrichment(
          yvTokenTx.contractAddress,
          ctx.chainId,
        );
        if (enrichment) {
          metadata["handler:vault_apy"] = enrichment.vault_apy;
          if (enrichment.vault_tvl_usd) {
            metadata["handler:vault_tvl_usd"] = enrichment.vault_tvl_usd;
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Yearn enrichment failed: ${msg}`;
      }
    }

    const descData = { type: "defi" as const, protocol: "Yearn", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash, summary };
    const handlerEntry = buildHandlerEntry({
      date,
      description: renderDescription(descData),
      descriptionData: descData,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: yvTokens should not fetch exchange rates
    const yvTokenCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isYvToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of yvTokenCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
