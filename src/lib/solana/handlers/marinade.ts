import Decimal from "decimal.js-light";
import type { HandlerResult, HandlerEntry } from "../../handlers/types.js";
import type { ItemAccum } from "../../handlers/item-builder.js";
import { mergeItemAccums } from "../../handlers/item-builder.js";
import { walletAssets, defiAssets, chainFees } from "../../accounts/paths.js";
import { renderDescription, solDefiDescription } from "../../types/description-data.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";
import { lamportsToSol } from "./generic-solana.js";

const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

/**
 * Marinade liquid staking handler (score: 55).
 * Handles SOL ↔ mSOL conversions.
 */
export const marinadeHandler: SolanaHandler = {
  id: "marinade",
  name: "Marinade Finance",
  description: "Marinade liquid staking (SOL ↔ mSOL)",

  match(tx: SolTxGroup): number {
    if (tx.status === "failed") return 0;
    const hasMarinade = tx.instructions.some(ix => ix.programId === MARINADE_PROGRAM);
    if (hasMarinade) return 55;
    // Also match by mSOL token transfer with Marinade source
    const hasMsol = tx.tokenTransfers.some(t => t.mint === MSOL_MINT);
    if (hasMsol && tx.source === "MARINADE") return 55;
    return 0;
  },

  async process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult> {
    const items: ItemAccum[] = [];
    const walletAccount = walletAssets("Solana", ctx.label);
    const marinadeAccount = defiAssets("Marinade", "Staking");

    await ctx.ensureCurrency("SOL", 9);
    await ctx.ensureCurrency("mSOL", 9, MSOL_MINT);

    // Analyze flows
    let netSolLamports = 0;
    for (const nt of tx.nativeTransfers) {
      if (nt.from === ctx.address && nt.to !== ctx.address) netSolLamports -= nt.amount;
      else if (nt.to === ctx.address && nt.from !== ctx.address) netSolLamports += nt.amount;
    }

    let netMsol = new Decimal(0);
    for (const t of tx.tokenTransfers) {
      if (t.mint !== MSOL_MINT) continue;
      const rawAmount = new Decimal(t.amount).dividedBy(new Decimal(10).pow(t.decimals));
      if (t.from === ctx.address) netMsol = netMsol.minus(rawAmount);
      else if (t.to === ctx.address) netMsol = netMsol.plus(rawAmount);
    }

    let action: string;

    if (netSolLamports < 0 && netMsol.greaterThan(0)) {
      // Stake: SOL → mSOL
      action = "stake";
      const solAmount = lamportsToSol(Math.abs(netSolLamports));
      items.push(
        { account: walletAccount, currency: "SOL", amount: solAmount.negated() },
        { account: marinadeAccount, currency: "SOL", amount: solAmount },
        { account: walletAccount, currency: "mSOL", amount: netMsol },
        { account: marinadeAccount, currency: "mSOL", amount: netMsol.negated() },
      );
    } else if (netSolLamports > 0 && netMsol.lessThan(0)) {
      // Unstake: mSOL → SOL
      action = "unstake";
      const solAmount = lamportsToSol(netSolLamports);
      items.push(
        { account: walletAccount, currency: "SOL", amount: solAmount },
        { account: marinadeAccount, currency: "SOL", amount: solAmount.negated() },
        { account: walletAccount, currency: "mSOL", amount: netMsol },
        { account: marinadeAccount, currency: "mSOL", amount: netMsol.negated() },
      );
    } else {
      action = "interaction";
    }

    // Fee
    if (tx.feePayer === ctx.address && tx.fee > 0) {
      items.push(
        { account: chainFees("Solana"), currency: "SOL", amount: lamportsToSol(tx.fee) },
        { account: walletAccount, currency: "SOL", amount: lamportsToSol(-tx.fee) },
      );
    }

    const merged = mergeItemAccums(items);
    if (merged.length === 0) return { type: "skip", reason: "No Marinade operation detected" };

    const date = new Date(tx.timestamp * 1000).toISOString().split("T")[0];
    const summary = `Marinade (Solana): ${action} SOL/mSOL`;
    const descriptionData = solDefiDescription("Marinade", action, tx.signature, summary);

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
        "sol:handler": "marinade",
        "sol:action": action,
      },
    };

    return { type: "entries", entries: [entry] };
  },
};
