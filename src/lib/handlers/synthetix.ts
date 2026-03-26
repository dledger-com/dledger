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
import { isSynthetixContract, SYNTHETIX } from "./addresses.js";
import { defiAssets, defiIncome, defiLiabilities } from "../accounts/paths.js";

// ---- Action classification ----

type SynthetixAction =
  | "DEPOSIT_COLLATERAL"
  | "WITHDRAW_COLLATERAL"
  | "MINT_SUSD"
  | "BURN_SUSD"
  | "CLAIM_REWARDS"
  | "UNKNOWN";

const ACTION_LABELS: Record<SynthetixAction, string> = {
  DEPOSIT_COLLATERAL: "Deposit Collateral",
  WITHDRAW_COLLATERAL: "Withdraw Collateral",
  MINT_SUSD: "Mint sUSD",
  BURN_SUSD: "Burn sUSD",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(
  flows: TokenFlow[],
  group: TxHashGroup,
  addr: string,
): SynthetixAction {
  const snxOut = flows.some(
    (f) => f.symbol === "SNX" && f.direction === "out",
  );
  const snxIn = flows.some(
    (f) => f.symbol === "SNX" && f.direction === "in",
  );
  const susdIn = flows.some(
    (f) => f.symbol === "sUSD" && f.direction === "in",
  );
  const susdOut = flows.some(
    (f) => f.symbol === "sUSD" && f.direction === "out",
  );
  const hasOutflow = flows.some((f) => f.direction === "out");

  // CLAIM_REWARDS: SNX inflow with no outflows
  if (snxIn && !hasOutflow) return "CLAIM_REWARDS";

  // DEPOSIT_COLLATERAL: SNX outflow to Synthetix
  if (snxOut && !susdIn) return "DEPOSIT_COLLATERAL";

  // MINT_SUSD: sUSD inflow (minted) possibly with SNX collateral
  if (susdIn && snxOut) return "MINT_SUSD";
  if (susdIn && !hasOutflow) return "MINT_SUSD";

  // BURN_SUSD: sUSD outflow
  if (susdOut && !snxOut) return "BURN_SUSD";

  // WITHDRAW_COLLATERAL: SNX inflow with possible sUSD burn
  if (snxIn && susdOut) return "WITHDRAW_COLLATERAL";
  if (snxIn) return "WITHDRAW_COLLATERAL";

  return "UNKNOWN";
}

// ---- Handler ----

export const synthetixHandler: TransactionHandler = {
  id: "synthetix",
  name: "Synthetix",
  description: "Interprets Synthetix collateral, sUSD minting, and reward transactions",
  website: "https://synthetix.io",
  supportedChainIds: [1, 10],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check normal tx target
    if (group.normal) {
      if (isSynthetixContract(group.normal.to)) return 55;
    }

    // Check ERC20 transfers
    const hasSynthetixInteraction = group.normal
      ? isSynthetixContract(group.normal.to)
      : false;

    for (const erc20 of group.erc20s) {
      // SNX token or sUSD
      if (erc20.tokenSymbol === "SNX" || erc20.tokenSymbol === "sUSD") {
        // Only match if also interacting with a Synthetix contract
        if (hasSynthetixInteraction) return 55;
        // Or if the ERC20 transfer involves a Synthetix contract
        if (
          isSynthetixContract(erc20.from) ||
          isSynthetixContract(erc20.to)
        ) {
          return 55;
        }
      }
      // Synth pattern /^s[A-Z]/ — only match with Synthetix contract interaction
      if (/^s[A-Z]/.test(erc20.tokenSymbol) && hasSynthetixInteraction) {
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

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(group, addr, ctx.chain, ctx.label, ctx);
    let merged = mergeItemAccums(allItems);

    // Remap accounts based on action
    if (action === "DEPOSIT_COLLATERAL" || action === "WITHDRAW_COLLATERAL") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiAssets("Synthetix", "Collateral") },
      ]);
    } else if (action === "MINT_SUSD" || action === "BURN_SUSD") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiLiabilities("Synthetix", "Debt") },
      ]);
    } else if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome("Synthetix", "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const primary = flows.find((f) => f.symbol !== "SNX") ?? flows[0];
    const amountStr = primary
      ? ` ${formatTokenAmount(primary.amount, primary.symbol)}`
      : "";
    const description = `Synthetix: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "synthetix",
      "handler:action": action,
    };

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol: "Synthetix", action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
