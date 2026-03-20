import Decimal from "decimal.js-light";
import type { HandlerResult, HandlerEntry } from "../../handlers/types.js";
import type { ItemAccum } from "../../handlers/item-builder.js";
import { mergeItemAccums } from "../../handlers/item-builder.js";
import { walletAssets, defiAssets, defiIncome, chainFees } from "../../accounts/paths.js";
import { renderDescription, type DescriptionData } from "../../types/description-data.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";
import { lamportsToSol } from "./generic-solana.js";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const STAKE_CONFIG = "StakeConfig11111111111111111111111111111111";

/**
 * Native staking handler (score: 50).
 * Handles SOL staking: delegate, deactivate, withdraw.
 */
export const nativeStakingHandler: SolanaHandler = {
  id: "native-staking",
  name: "SOL Native Staking",
  description: "SOL native staking operations (delegate, deactivate, withdraw)",

  match(tx: SolTxGroup): number {
    if (tx.status === "failed") return 0;
    const hasStakeIx = tx.instructions.some(
      ix => ix.programId === STAKE_PROGRAM || ix.programId === STAKE_CONFIG,
    );
    return hasStakeIx ? 50 : 0;
  },

  async process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult> {
    const items: ItemAccum[] = [];
    const walletAccount = walletAssets("Solana", ctx.label);
    const stakedAccount = defiAssets("SOLStaking", "Staked");
    const rewardsAccount = defiIncome("SOLStaking", "Rewards");

    await ctx.ensureCurrency("SOL", 9);

    // Analyze SOL flows
    let solSent = 0; // lamports sent from wallet
    let solReceived = 0; // lamports received to wallet

    for (const nt of tx.nativeTransfers) {
      if (nt.from === ctx.address && nt.to !== ctx.address) {
        solSent += nt.amount;
      } else if (nt.to === ctx.address && nt.from !== ctx.address) {
        solReceived += nt.amount;
      }
    }

    // Determine staking action
    let action: string;

    if (solSent > 0 && solReceived === 0) {
      // Delegate: SOL goes from wallet to staked position
      action = "delegate";
      const stakeAmount = lamportsToSol(solSent);
      items.push(
        { account: walletAccount, currency: "SOL", amount: stakeAmount.negated() },
        { account: stakedAccount, currency: "SOL", amount: stakeAmount },
      );
    } else if (solReceived > 0 && solSent === 0) {
      // Withdraw: SOL comes back from staked position
      // Check if received > original stake (i.e., includes rewards)
      action = "withdraw";
      const withdrawAmount = lamportsToSol(solReceived);

      items.push(
        { account: walletAccount, currency: "SOL", amount: withdrawAmount },
        { account: stakedAccount, currency: "SOL", amount: withdrawAmount.negated() },
      );
    } else if (solSent > 0 && solReceived > 0) {
      // Merge or partial withdrawal
      action = "rebalance";
      const netLamports = solReceived - solSent;
      if (netLamports !== 0) {
        items.push(
          { account: walletAccount, currency: "SOL", amount: lamportsToSol(netLamports) },
          { account: stakedAccount, currency: "SOL", amount: lamportsToSol(-netLamports) },
        );
      }
    } else {
      // Deactivate (no SOL movement) or other state change
      action = "deactivate";
    }

    // Fee
    if (tx.feePayer === ctx.address && tx.fee > 0) {
      items.push(
        { account: chainFees("Solana"), currency: "SOL", amount: lamportsToSol(tx.fee) },
        { account: walletAccount, currency: "SOL", amount: lamportsToSol(-tx.fee) },
      );
    }

    const merged = mergeItemAccums(items);

    if (merged.length === 0 && action === "deactivate") {
      // Deactivate has no SOL movement, just record fee if any
      if (tx.fee === 0) return { type: "skip", reason: "No-op staking tx" };
    }

    const date = new Date(tx.timestamp * 1000).toISOString().split("T")[0];

    const descriptionData: DescriptionData = {
      type: "sol-defi",
      protocol: "SOL Staking",
      action,
      signature: tx.signature,
      summary: `SOL Staking: ${action}`,
    };

    const entry: HandlerEntry = {
      entry: {
        date,
        description: renderDescription(descriptionData),
        description_data: JSON.stringify(descriptionData),
        status: "confirmed",
        source: `solana:${tx.signature}`,
        voided_by: null,
      },
      items: merged.map(item => ({
        account_id: item.account,
        currency: item.currency,
        amount: item.amount.toString(),
        lot_id: null,
      })),
      metadata: {
        "sol:signature": tx.signature,
        "sol:slot": String(tx.slot),
        "sol:timestamp": String(tx.timestamp),
        "sol:fee_lamports": String(tx.fee),
        "sol:handler": "native-staking",
        "sol:staking_action": action,
      },
    };

    return { type: "entries", entries: [entry] };
  },
};
