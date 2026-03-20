import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
  Erc20Tx,
} from "./types.js";
import { timestampToDate, weiToNative } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  formatTokenAmount,
} from "./item-builder.js";
import { isLidoContract, LIDO, ZERO_ADDRESS } from "./addresses.js";

// ---- Action classification ----

type LidoAction =
  | "STAKE_ETH"
  | "WRAP"
  | "UNWRAP"
  | "REQUEST_WITHDRAWAL"
  | "CLAIM_WITHDRAWAL"
  | "UNKNOWN";

const ACTION_LABELS: Record<LidoAction, string> = {
  STAKE_ETH: "Stake",
  WRAP: "Wrap stETH to wstETH",
  UNWRAP: "Unwrap wstETH to stETH",
  REQUEST_WITHDRAWAL: "Request Withdrawal",
  CLAIM_WITHDRAWAL: "Claim Withdrawal",
  UNKNOWN: "Interact",
};

function classifyAction(
  group: TxHashGroup,
  addr: string,
  chainId: number,
): LidoAction {
  const flows = analyzeErc20Flows(group.erc20s, addr);
  const wstethAddr = LIDO.WSTETH_BY_CHAIN[chainId]?.toLowerCase();

  // STAKE_ETH: Normal tx with value > 0 to stETH contract + stETH minted from 0x0
  if (group.normal) {
    const normalTo = group.normal.to.toLowerCase();
    const normalValue = group.normal.value;
    if (
      normalTo === LIDO.STETH &&
      normalValue !== "0" &&
      flows.some((f) => f.symbol === "stETH" && f.isMint && f.direction === "in")
    ) {
      return "STAKE_ETH";
    }
  }

  // WRAP: stETH outflow + wstETH inflow
  const stethOut = flows.some(
    (f) => f.symbol === "stETH" && f.direction === "out",
  );
  const wstethIn = flows.some(
    (f) =>
      f.symbol === "wstETH" &&
      f.direction === "in" &&
      (!wstethAddr || f.contractAddress === wstethAddr),
  );
  if (stethOut && wstethIn) return "WRAP";

  // UNWRAP: wstETH outflow + stETH inflow
  const wstethOut = flows.some(
    (f) => f.symbol === "wstETH" && f.direction === "out",
  );
  const stethIn = flows.some(
    (f) => f.symbol === "stETH" && f.direction === "in",
  );
  if (wstethOut && stethIn) return "UNWRAP";

  // REQUEST_WITHDRAWAL: stETH/wstETH outflow + withdrawal NFT minted
  const hasStethOrWstethOut = stethOut || wstethOut;
  const hasWithdrawalNftMint = group.erc721s.some(
    (nft) =>
      nft.from.toLowerCase() === ZERO_ADDRESS &&
      nft.contractAddress.toLowerCase() === LIDO.WITHDRAWAL_QUEUE,
  );
  if (hasStethOrWstethOut && hasWithdrawalNftMint) return "REQUEST_WITHDRAWAL";

  // CLAIM_WITHDRAWAL: NFT burned + internal tx ETH to user
  const hasNftBurn = group.erc721s.some(
    (nft) =>
      nft.to.toLowerCase() === ZERO_ADDRESS &&
      nft.contractAddress.toLowerCase() === LIDO.WITHDRAWAL_QUEUE,
  );
  const hasInternalEthToUser = group.internals.some(
    (itx) => itx.to.toLowerCase() === addr && itx.value !== "0",
  );
  if (hasNftBurn && hasInternalEthToUser) return "CLAIM_WITHDRAWAL";

  return "UNKNOWN";
}

// ---- Description builder ----

function buildDescription(
  action: LidoAction,
  group: TxHashGroup,
  addr: string,
  chainDecimals: number,
): string {
  const hashShort =
    group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;
  const label = ACTION_LABELS[action];

  if (action === "STAKE_ETH" && group.normal) {
    const ethAmount = weiToNative(group.normal.value, chainDecimals);
    return `Lido: ${label} ${formatTokenAmount(ethAmount, "ETH")} for stETH (${hashShort})`;
  }

  return `Lido: ${label} (${hashShort})`;
}

// ---- Enrichment via Lido API ----

async function fetchLidoStakingApr(): Promise<string | null> {
  const resp = await fetch("https://eth-api.lido.fi/v1/protocol/steth/apr/sma");
  if (!resp.ok) return null;

  const data = await resp.json();
  const apr = data?.data?.smaApr ?? data?.data?.apr;
  if (apr == null) return null;

  return String(apr);
}

// ---- Handler ----

export const lidoHandler: TransactionHandler = {
  id: "lido",
  name: "Lido Finance",
  description: "Interprets Lido liquid staking transactions",
  website: "https://lido.fi",
  supportedChainIds: [1, 42161, 10, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isLidoContract(group.normal.to, ctx.chainId)) return 55;
    }

    // Check ERC20 symbols
    for (const erc20 of group.erc20s) {
      if (erc20.tokenSymbol === "stETH" || erc20.tokenSymbol === "wstETH") {
        return 55;
      }
    }

    // Check ERC721 from withdrawal queue
    for (const erc721 of group.erc721s) {
      if (
        erc721.contractAddress.toLowerCase() === LIDO.WITHDRAWAL_QUEUE
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

    const action = classifyAction(group, addr, ctx.chainId);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    const merged = mergeItemAccums(allItems);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    const description = buildDescription(
      action,
      group,
      addr,
      ctx.chain.decimals,
    );

    const metadata: Record<string, string> = {
      handler: "lido",
      "handler:action": action,
    };

    // Enrichment: fetch staking APR from Lido API (opt-in)
    if (ctx.enrichment && (action === "STAKE_ETH" || action === "WRAP")) {
      try {
        const stakingApr = await fetchLidoStakingApr();
        if (stakingApr) {
          metadata["handler:staking_apr"] = stakingApr;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Lido enrichment failed: ${msg}`;
      }
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Lido", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
