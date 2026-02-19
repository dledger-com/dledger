import Decimal from "decimal.js-light";
import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  HandlerEntry,
  TxHashGroup,
  Erc20Tx,
} from "./types.js";
import {
  weiToNative,
  calculateGasFee,
  shortAddr,
  timestampToDate,
} from "../browser-etherscan.js";

// ---- Constants ----

const PENDLE_ROUTER_V4 = "0x888888888889758f76e7103c6cbf23abbf58f946";
const PENDLE_LIMIT_ROUTER = "0x000000000000c9b3e2c3ec88b1b4c0cd853f4321";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---- Token detection ----

function isPendleToken(symbol: string): boolean {
  return (
    /^PT-/.test(symbol) ||
    /^YT-/.test(symbol) ||
    /^SY-/.test(symbol) ||
    symbol === "PENDLE-LPT"
  );
}

// ---- Action classification ----

type PendleAction =
  | "MINT_PY"
  | "REDEEM_PY"
  | "ADD_LIQUIDITY"
  | "REMOVE_LIQUIDITY"
  | "BUY_PT"
  | "SELL_PT"
  | "BUY_YT"
  | "SELL_YT"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

const ACTION_LABELS: Record<PendleAction, string> = {
  MINT_PY: "Mint PT+YT from",
  REDEEM_PY: "Redeem PT+YT to",
  ADD_LIQUIDITY: "Add Liquidity to",
  REMOVE_LIQUIDITY: "Remove Liquidity from",
  BUY_PT: "Buy PT",
  SELL_PT: "Sell PT",
  BUY_YT: "Buy YT",
  SELL_YT: "Sell YT",
  CLAIM_REWARDS: "Claim Rewards from",
  UNKNOWN: "Interact with",
};

function classifyAction(
  erc20s: Erc20Tx[],
  addr: string,
): PendleAction {
  const ptTokens = erc20s.filter((tx) => tx.tokenSymbol.startsWith("PT-"));
  const ytTokens = erc20s.filter((tx) => tx.tokenSymbol.startsWith("YT-"));
  const lpTokens = erc20s.filter((tx) => tx.tokenSymbol === "PENDLE-LPT");

  const ptMinted = ptTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const ytMinted = ytTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const ptBurned = ptTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );
  const ytBurned = ytTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );
  const lpMinted = lpTokens.some(
    (tx) => tx.from.toLowerCase() === ZERO_ADDRESS && tx.to.toLowerCase() === addr,
  );
  const lpBurned = lpTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() === ZERO_ADDRESS,
  );

  // PT + YT minted from zero address to user
  if (ptMinted && ytMinted) return "MINT_PY";

  // PT + YT burned from user to zero address
  if (ptBurned && ytBurned) return "REDEEM_PY";

  // LP token minted
  if (lpMinted) return "ADD_LIQUIDITY";

  // LP token burned
  if (lpBurned) return "REMOVE_LIQUIDITY";

  // No LP involvement for PT/YT trades
  const hasLP = lpTokens.length > 0;

  // PT out from user (selling PT)
  const ptOutFromUser = ptTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ptOutFromUser && !hasLP) return "SELL_PT";

  // PT in to user (buying PT)
  const ptInToUser = ptTokens.some(
    (tx) => tx.to.toLowerCase() === addr && tx.from.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ptInToUser && !hasLP) return "BUY_PT";

  // YT out from user (selling YT)
  const ytOutFromUser = ytTokens.some(
    (tx) => tx.from.toLowerCase() === addr && tx.to.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ytOutFromUser && !hasLP) return "SELL_YT";

  // YT in to user (buying YT)
  const ytInToUser = ytTokens.some(
    (tx) => tx.to.toLowerCase() === addr && tx.from.toLowerCase() !== ZERO_ADDRESS,
  );
  if (ytInToUser && !hasLP) return "BUY_YT";

  // Only reward tokens in, no outflows from user
  const hasOutflows = erc20s.some(
    (tx) => tx.from.toLowerCase() === addr,
  );
  const hasInflows = erc20s.some(
    (tx) => tx.to.toLowerCase() === addr,
  );
  if (hasInflows && !hasOutflows) return "CLAIM_REWARDS";

  return "UNKNOWN";
}

// ---- Market name extraction ----

function extractMarketInfo(erc20s: Erc20Tx[]): {
  marketName: string;
  underlying: string;
} {
  for (const tx of erc20s) {
    const sym = tx.tokenSymbol;
    // Match PT-stETH-25DEC25, YT-stETH-25DEC25, SY-stETH
    const ptMatch = sym.match(/^PT-(.+)$/);
    const ytMatch = sym.match(/^YT-(.+)$/);
    const syMatch = sym.match(/^SY-(.+)$/);

    if (ptMatch) {
      const market = ptMatch[1]; // e.g. "stETH-25DEC25"
      // Underlying is everything before the last dash-date segment
      const dashParts = market.split("-");
      const underlying =
        dashParts.length > 1
          ? dashParts.slice(0, -1).join("-")
          : market;
      return { marketName: market, underlying };
    }
    if (ytMatch) {
      const market = ytMatch[1];
      const dashParts = market.split("-");
      const underlying =
        dashParts.length > 1
          ? dashParts.slice(0, -1).join("-")
          : market;
      return { marketName: market, underlying };
    }
    if (syMatch) {
      return { marketName: syMatch[1], underlying: syMatch[1] };
    }
  }
  return { marketName: "", underlying: "" };
}

// ---- Pendle API enrichment ----

interface PendleApiResponse {
  total: number;
  limit: number;
  skip: number;
  results: Array<{
    txHash: string;
    action: string;
    valuation?: { usd?: number };
    impliedApy?: number;
    market?: { name?: string };
  }>;
}

interface PendleEnrichment {
  action: string;
  usd_value: string;
  implied_apy: string;
}

async function fetchPendleEnrichment(
  chainId: number,
  address: string,
  txHash: string,
): Promise<PendleEnrichment | null> {
  const url = `https://api-v2.pendle.finance/core/v5/${chainId}/transactions/${address}?limit=100&skip=0`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data: PendleApiResponse = await resp.json();
  const match = data.results.find(
    (r) => r.txHash.toLowerCase() === txHash.toLowerCase(),
  );
  if (!match) return null;

  return {
    action: match.action,
    usd_value: match.valuation?.usd?.toString() ?? "",
    implied_apy: match.impliedApy?.toString() ?? "",
  };
}

// ---- Item building helpers (mirrors generic handler logic) ----

interface ItemAccum {
  account: string;
  amount: Decimal;
  currency: string;
}

function mergeItemAccums(items: ItemAccum[]): ItemAccum[] {
  const sums = new Map<string, Decimal>();

  for (const item of items) {
    const key = `${item.account}|${item.currency}`;
    const existing = sums.get(key);
    if (existing) {
      sums.set(key, existing.plus(item.amount));
    } else {
      sums.set(key, item.amount);
    }
  }

  const merged: ItemAccum[] = [];
  for (const [key, amount] of sums) {
    if (amount.isZero()) continue;
    const [account, currency] = key.split("|", 2);
    merged.push({ account, amount, currency });
  }

  return merged;
}

// ---- Handler ----

export const pendleHandler: TransactionHandler = {
  id: "pendle",
  name: "Pendle Finance",
  description: "Interprets Pendle yield trading transactions",
  supportedChainIds: [1, 42161, 8453, 56, 10, 5000, 43114],

  match(group: TxHashGroup, _ctx: HandlerContext): number {
    // Check ERC20 transfers for Pendle tokens
    for (const erc20 of group.erc20s) {
      if (isPendleToken(erc20.tokenSymbol)) return 60;
    }

    // Check normal tx target
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (to === PENDLE_ROUTER_V4 || to === PENDLE_LIMIT_ROUTER) return 60;
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const chain = ctx.chain;
    const date = timestampToDate(group.timestamp);
    const hashShort =
      group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    // 1. Classify the action
    const action = classifyAction(group.erc20s, addr);

    // 2. Try Pendle API enrichment
    let enrichment: PendleEnrichment | null = null;
    const warnings: string[] = [];
    try {
      enrichment = await fetchPendleEnrichment(
        ctx.chainId,
        ctx.address,
        group.hash,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Pendle API enrichment failed: ${msg}`);
    }

    // 3. Extract market name
    const { marketName, underlying } = extractMarketInfo(group.erc20s);

    // 4. Build items using the same logic as the generic handler
    const allItems: ItemAccum[] = [];
    const chainName = chain.name;
    const ourAccount = `Assets:${chainName}:${ctx.label}`;
    const nativeCurr = chain.native_currency;

    // Ensure native currency
    await ctx.ensureCurrency(nativeCurr, chain.decimals);

    // Normal tx items
    if (group.normal) {
      const tx = group.normal;
      const value = weiToNative(tx.value, chain.decimals);
      const gasFee = calculateGasFee(tx.gasUsed, tx.gasPrice, chain.decimals);
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();

      if (from === addr && to === addr) {
        // Self-transfer: only gas
        if (!gasFee.isZero()) {
          allItems.push({ account: `Expenses:${chainName}:Gas`, amount: gasFee, currency: nativeCurr });
          allItems.push({ account: ourAccount, amount: gasFee.neg(), currency: nativeCurr });
        }
      } else if (!to) {
        // Contract creation
        if (!gasFee.isZero()) {
          allItems.push({ account: `Expenses:${chainName}:ContractCreation`, amount: gasFee, currency: nativeCurr });
          allItems.push({ account: ourAccount, amount: gasFee.neg(), currency: nativeCurr });
        }
      } else if (from === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
        if (!value.isZero()) {
          allItems.push({ account: extAccount, amount: value, currency: nativeCurr });
        }
        if (!gasFee.isZero()) {
          allItems.push({ account: `Expenses:${chainName}:Gas`, amount: gasFee, currency: nativeCurr });
        }
        const totalOut = value.plus(gasFee);
        if (!totalOut.isZero()) {
          allItems.push({ account: ourAccount, amount: totalOut.neg(), currency: nativeCurr });
        }
      } else if (to === addr) {
        if (!value.isZero()) {
          const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
          allItems.push({ account: ourAccount, amount: value, currency: nativeCurr });
          allItems.push({ account: extAccount, amount: value.neg(), currency: nativeCurr });
        }
      }
    }

    // Internal tx items
    for (const internal of group.internals) {
      if (internal.isError === "1") continue;
      const value = weiToNative(internal.value, chain.decimals);
      if (value.isZero()) continue;

      const from = internal.from.toLowerCase();
      const to = internal.to.toLowerCase();

      if (from === addr && to === addr) {
        // Self-transfer: no net effect
      } else if (from === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
        allItems.push({ account: extAccount, amount: value, currency: nativeCurr });
        allItems.push({ account: ourAccount, amount: value.neg(), currency: nativeCurr });
      } else if (to === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
        allItems.push({ account: ourAccount, amount: value, currency: nativeCurr });
        allItems.push({ account: extAccount, amount: value.neg(), currency: nativeCurr });
      }
    }

    // ERC20 items
    for (const erc20 of group.erc20s) {
      const decimals = parseInt(erc20.tokenDecimal, 10) || 18;
      const value = weiToNative(erc20.value, decimals);
      if (value.isZero()) continue;

      const currency =
        erc20.tokenSymbol || `ERC20:${shortAddr(erc20.contractAddress)}`;
      await ctx.ensureCurrency(currency, decimals);

      const from = erc20.from.toLowerCase();
      const to = erc20.to.toLowerCase();

      if (from === addr && to === addr) {
        // Self-transfer: no net effect
      } else if (from === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
        allItems.push({ account: extAccount, amount: value, currency });
        allItems.push({ account: ourAccount, amount: value.neg(), currency });
      } else if (to === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
        allItems.push({ account: ourAccount, amount: value, currency });
        allItems.push({ account: extAccount, amount: value.neg(), currency });
      }
    }

    // ERC721 items
    for (const erc721 of group.erc721s) {
      const value = new Decimal(1);
      const currency =
        erc721.tokenSymbol || `NFT:${shortAddr(erc721.contractAddress)}`;
      await ctx.ensureCurrency(currency, 0);

      const from = erc721.from.toLowerCase();
      const to = erc721.to.toLowerCase();

      if (from === addr && to === addr) {
        // Self-transfer: no net effect
      } else if (from === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
        allItems.push({ account: extAccount, amount: value, currency });
        allItems.push({ account: ourAccount, amount: value.neg(), currency });
      } else if (to === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
        allItems.push({ account: ourAccount, amount: value, currency });
        allItems.push({ account: extAccount, amount: value.neg(), currency });
      }
    }

    // ERC1155 items
    for (const erc1155 of group.erc1155s) {
      let value: Decimal;
      try {
        value = new Decimal(erc1155.tokenValue || "0");
      } catch {
        value = new Decimal(0);
      }
      if (value.isZero()) continue;

      const currency =
        erc1155.tokenSymbol || `ERC1155:${shortAddr(erc1155.contractAddress)}`;
      await ctx.ensureCurrency(currency, 0);

      const from = erc1155.from.toLowerCase();
      const to = erc1155.to.toLowerCase();

      if (from === addr && to === addr) {
        // Self-transfer: no net effect
      } else if (from === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
        allItems.push({ account: extAccount, amount: value, currency });
        allItems.push({ account: ourAccount, amount: value.neg(), currency });
      } else if (to === addr) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
        allItems.push({ account: ourAccount, amount: value, currency });
        allItems.push({ account: extAccount, amount: value.neg(), currency });
      }
    }

    // Merge items sharing the same (account, currency)
    const merged = mergeItemAccums(allItems);

    // 7. If no net movement, skip
    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    // Resolve account IDs and build final line items
    const lineItems: Omit<import("../types/index.js").LineItem, "id" | "journal_entry_id">[] = [];
    for (const item of merged) {
      const accountId = await ctx.ensureAccount(item.account, date);
      lineItems.push({
        account_id: accountId,
        currency: item.currency,
        amount: item.amount.toString(),
        lot_id: null,
      });
    }

    // 5. Build description
    const actionLabel = ACTION_LABELS[action];
    const marketInfo = marketName || underlying || "";
    const description = marketInfo
      ? `Pendle: ${actionLabel} ${marketInfo} (${hashShort})`
      : `Pendle: ${actionLabel} (${hashShort})`;

    // 6. Build metadata
    const metadata: Record<string, string> = {
      handler: "pendle",
      "handler:action": action,
      "handler:market": marketName || "",
      "handler:underlying": underlying || "",
    };
    if (enrichment) {
      metadata["handler:usd_value"] = enrichment.usd_value;
      metadata["handler:implied_apy"] = enrichment.implied_apy;
    }
    if (warnings.length > 0) {
      metadata["handler:warnings"] = warnings.join("; ");
    }

    // 8. Build and return the handler entry
    const handlerEntry: HandlerEntry = {
      entry: {
        date,
        description,
        status: "confirmed",
        source: `etherscan:${ctx.chainId}:${group.hash}`,
        voided_by: null,
      },
      items: lineItems,
      metadata,
    };

    const pendleTokens = allItems
      .map((i) => i.currency)
      .filter((c) => isPendleToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of pendleTokens) {
      currencyHints[token] = null; // null = no public rate source
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
