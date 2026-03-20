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
import { BALANCER, isBalancerContract, ZERO_ADDRESS } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";

// ---- Token detection ----

function isBptToken(symbol: string): boolean {
  return /^B-/.test(symbol);
}

// ---- Action classification ----

type BalancerAction = "JOIN_POOL" | "EXIT_POOL" | "SWAP" | "CLAIM_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<BalancerAction, string> = {
  JOIN_POOL: "Join Pool",
  EXIT_POOL: "Exit Pool",
  SWAP: "Swap",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): BalancerAction {
  const bptMinted = flows.some((f) => isBptToken(f.symbol) && f.isMint);
  const bptBurned = flows.some((f) => isBptToken(f.symbol) && f.isBurn);
  const bptIn = flows.some((f) => isBptToken(f.symbol) && f.direction === "in");
  const bptOut = flows.some((f) => isBptToken(f.symbol) && f.direction === "out");
  const balInflow = flows.some(
    (f) => f.symbol === "BAL" && f.direction === "in",
  );
  const hasNonBptNonBalOutflow = flows.some(
    (f) => f.direction === "out" && !isBptToken(f.symbol) && f.symbol !== "BAL",
  );
  const hasNonBptNonBalInflow = flows.some(
    (f) => f.direction === "in" && !isBptToken(f.symbol) && f.symbol !== "BAL",
  );

  // JOIN_POOL: BPT minted or received + underlying outflow
  if ((bptMinted || bptIn) && hasNonBptNonBalOutflow) return "JOIN_POOL";

  // EXIT_POOL: BPT burned or sent out + underlying inflow
  if ((bptBurned || bptOut) && hasNonBptNonBalInflow) return "EXIT_POOL";

  // CLAIM_REWARDS: BAL inflow only, no BPT movement
  if (balInflow && !bptMinted && !bptBurned && !bptIn && !bptOut && !hasNonBptNonBalOutflow) {
    return "CLAIM_REWARDS";
  }

  // SWAP: interaction with Vault, non-BPT tokens swapped
  if (hasNonBptNonBalInflow && hasNonBptNonBalOutflow) return "SWAP";

  return "UNKNOWN";
}

// ---- Find primary token flow for description ----

function findPrimaryFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find((f) => !isBptToken(f.symbol) && f.symbol !== "BAL");
}

// ---- Enrichment via Balancer API ----

interface BalancerEnrichment {
  pool_apr: string;
  pool_tvl_usd: string;
}

const CHAIN_ID_TO_BALANCER: Record<number, string> = {
  1: "MAINNET",
  42161: "ARBITRUM",
  10: "OPTIMISM",
  137: "POLYGON",
  8453: "BASE",
};

async function fetchBalancerEnrichment(
  poolAddress: string,
  chainId: number,
): Promise<BalancerEnrichment | null> {
  const chain = CHAIN_ID_TO_BALANCER[chainId];
  if (!chain) return null;

  const query = `{
    poolGetPool(id: "${poolAddress.toLowerCase()}", chain: ${chain}) {
      dynamicData {
        totalLiquidity
        aprItems {
          apr
          type
        }
      }
    }
  }`;

  const resp = await fetch("https://api-v3.balancer.fi/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) return null;

  const json = await resp.json();
  const pool = json?.data?.poolGetPool;
  if (!pool?.dynamicData) return null;

  const aprItems: { apr: number; type: string }[] =
    pool.dynamicData.aprItems ?? [];
  const totalApr = aprItems.reduce(
    (sum: number, item: { apr: number }) => sum + (item.apr ?? 0),
    0,
  );
  const tvl = pool.dynamicData.totalLiquidity ?? "";

  return {
    pool_apr: totalApr.toString(),
    pool_tvl_usd: tvl.toString(),
  };
}

// ---- Handler ----

export const balancerHandler: TransactionHandler = {
  id: "balancer",
  name: "Balancer",
  description: "Interprets Balancer pool join/exit, swap, and reward transactions",
  website: "https://balancer.fi",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isBalancerContract(group.normal.to)) return 55;
    }

    // Check ERC20 symbols for BPT tokens or BAL
    for (const erc20 of group.erc20s) {
      if (isBptToken(erc20.tokenSymbol)) return 55;
      if (
        erc20.contractAddress.toLowerCase() === BALANCER.BAL_TOKEN &&
        erc20.tokenSymbol === "BAL"
      ) {
        return 55;
      }
    }

    // Check ERC20 transfers involving Vault
    for (const erc20 of group.erc20s) {
      if (
        erc20.from.toLowerCase() === BALANCER.VAULT ||
        erc20.to.toLowerCase() === BALANCER.VAULT
      ) {
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
    if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Balancer", "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = findPrimaryFlow(flows);
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `Balancer: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "balancer",
      "handler:action": action,
    };

    // Find BPT token for metadata + enrichment
    const bptTx = group.erc20s.find((tx) => isBptToken(tx.tokenSymbol));
    if (bptTx) {
      metadata["handler:bpt_token"] = bptTx.tokenSymbol;
    }

    // Enrichment: fetch pool APR from Balancer API (opt-in)
    if (ctx.enrichment && action === "JOIN_POOL" && bptTx) {
      try {
        const enrichment = await fetchBalancerEnrichment(
          bptTx.contractAddress,
          ctx.chainId,
        );
        if (enrichment) {
          metadata["handler:pool_apr"] = enrichment.pool_apr;
          if (enrichment.pool_tvl_usd) {
            metadata["handler:pool_tvl_usd"] = enrichment.pool_tvl_usd;
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Balancer enrichment failed: ${msg}`;
      }
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Balancer", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: BPT tokens should not fetch exchange rates
    const bptCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isBptToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of bptCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
