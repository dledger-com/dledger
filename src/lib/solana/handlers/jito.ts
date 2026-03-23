import Decimal from "decimal.js-light";
import type { HandlerResult, HandlerEntry } from "../../handlers/types.js";
import type { ItemAccum } from "../../handlers/item-builder.js";
import { mergeItemAccums } from "../../handlers/item-builder.js";
import { walletAssets, defiAssets, chainFees } from "../../accounts/paths.js";
import { renderDescription, solDefiDescription } from "../../types/description-data.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";
import { lamportsToSol } from "./generic-solana.js";

const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P3LsyLph8";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

/**
 * Jito liquid staking handler (score: 55).
 * Handles SOL ↔ jitoSOL conversions.
 */
export const jitoHandler: SolanaHandler = {
  id: "jito",
  name: "Jito",
  description: "Jito liquid staking (SOL ↔ jitoSOL)",

  match(tx: SolTxGroup): number {
    if (tx.status === "failed") return 0;
    const hasJito = tx.instructions.some(ix => ix.programId === JITO_STAKE_POOL);
    if (hasJito) return 55;
    const hasJitoSol = tx.tokenTransfers.some(t => t.mint === JITOSOL_MINT);
    if (hasJitoSol && tx.source === "JITO") return 55;
    return 0;
  },

  async process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult> {
    const items: ItemAccum[] = [];
    const walletAccount = walletAssets("Solana", ctx.label);
    const jitoAccount = defiAssets("Jito", "Staking");

    await ctx.ensureCurrency("SOL", 9);
    await ctx.ensureCurrency("jitoSOL", 9, JITOSOL_MINT);

    // Analyze flows
    let netSolLamports = 0;
    for (const nt of tx.nativeTransfers) {
      if (nt.from === ctx.address && nt.to !== ctx.address) netSolLamports -= nt.amount;
      else if (nt.to === ctx.address && nt.from !== ctx.address) netSolLamports += nt.amount;
    }

    let netJitoSol = new Decimal(0);
    for (const t of tx.tokenTransfers) {
      if (t.mint !== JITOSOL_MINT) continue;
      const rawAmount = new Decimal(t.amount).dividedBy(new Decimal(10).pow(t.decimals));
      if (t.from === ctx.address) netJitoSol = netJitoSol.minus(rawAmount);
      else if (t.to === ctx.address) netJitoSol = netJitoSol.plus(rawAmount);
    }

    let action: string;

    if (netSolLamports < 0 && netJitoSol.greaterThan(0)) {
      // Stake: SOL → jitoSOL
      action = "stake";
      const solAmount = lamportsToSol(Math.abs(netSolLamports));
      items.push(
        { account: walletAccount, currency: "SOL", amount: solAmount.negated() },
        { account: jitoAccount, currency: "SOL", amount: solAmount },
        { account: walletAccount, currency: "jitoSOL", amount: netJitoSol },
        { account: jitoAccount, currency: "jitoSOL", amount: netJitoSol.negated() },
      );
    } else if (netSolLamports > 0 && netJitoSol.lessThan(0)) {
      // Unstake: jitoSOL → SOL
      action = "unstake";
      const solAmount = lamportsToSol(netSolLamports);
      items.push(
        { account: walletAccount, currency: "SOL", amount: solAmount },
        { account: jitoAccount, currency: "SOL", amount: solAmount.negated() },
        { account: walletAccount, currency: "jitoSOL", amount: netJitoSol },
        { account: jitoAccount, currency: "jitoSOL", amount: netJitoSol.negated() },
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
    if (merged.length === 0) return { type: "skip", reason: "No Jito operation detected" };

    const date = new Date(tx.timestamp * 1000).toISOString().split("T")[0];
    const summary = `Jito: ${action} SOL/jitoSOL`;
    const descriptionData = solDefiDescription("Jito", action, tx.signature, summary);

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
        "sol:handler": "jito",
        "sol:action": action,
      },
    };

    return { type: "entries", entries: [entry] };
  },
};
