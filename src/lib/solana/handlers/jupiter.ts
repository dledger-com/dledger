import Decimal from "decimal.js-light";
import type { HandlerResult, HandlerEntry } from "../../handlers/types.js";
import type { ItemAccum } from "../../handlers/item-builder.js";
import { mergeItemAccums } from "../../handlers/item-builder.js";
import { walletAssets, defiAssets, chainFees } from "../../accounts/paths.js";
import { renderDescription, type DescriptionData } from "../../types/description-data.js";
import type { SolTxGroup, SolTokenTransfer } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";
import { lamportsToSol } from "./generic-solana.js";

const JUPITER_PROGRAM = "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd";

/**
 * Jupiter swap handler (score: 55).
 * Detects Jupiter aggregator swaps via programId or Helius source classification.
 */
export const jupiterHandler: SolanaHandler = {
  id: "jupiter",
  name: "Jupiter",
  description: "Jupiter DEX aggregator swaps on Solana",

  match(tx: SolTxGroup): number {
    if (tx.status === "failed") return 0;
    if (tx.source === "JUPITER") return 55;
    if (tx.instructions.some(ix => ix.programId === JUPITER_PROGRAM)) return 55;
    return 0;
  },

  async process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult> {
    const items: ItemAccum[] = [];
    const walletAccount = walletAssets("Solana", ctx.label);

    // Analyze token flows to identify input/output of the swap
    const inflows: { symbol: string; amount: Decimal; mint: string; decimals: number }[] = [];
    const outflows: { symbol: string; amount: Decimal; mint: string; decimals: number }[] = [];

    // SPL token flows
    for (const t of tx.tokenTransfers) {
      const isOutgoing = t.from === ctx.address;
      const isIncoming = t.to === ctx.address;
      if (!isOutgoing && !isIncoming) continue;

      const rawAmount = new Decimal(t.amount).dividedBy(new Decimal(10).pow(t.decimals));
      const symbol = t.tokenSymbol ?? t.mint.slice(0, 6);

      if (isOutgoing) {
        outflows.push({ symbol, amount: rawAmount, mint: t.mint, decimals: t.decimals });
      } else {
        inflows.push({ symbol, amount: rawAmount, mint: t.mint, decimals: t.decimals });
      }
    }

    // SOL native flows (excluding fee)
    let netSolLamports = 0;
    for (const nt of tx.nativeTransfers) {
      if (nt.from === ctx.address && nt.to !== ctx.address) {
        netSolLamports -= nt.amount;
      } else if (nt.to === ctx.address && nt.from !== ctx.address) {
        netSolLamports += nt.amount;
      }
    }

    if (netSolLamports !== 0) {
      const solAmount = lamportsToSol(Math.abs(netSolLamports));
      if (netSolLamports > 0) {
        inflows.push({ symbol: "SOL", amount: solAmount, mint: "SOL", decimals: 9 });
      } else {
        outflows.push({ symbol: "SOL", amount: solAmount, mint: "SOL", decimals: 9 });
      }
    }

    // Ensure currencies
    for (const flow of [...inflows, ...outflows]) {
      await ctx.ensureCurrency(flow.symbol, flow.decimals, flow.mint === "SOL" ? undefined : flow.mint);
    }

    // Build swap items: sold tokens decrease wallet, received tokens increase wallet
    for (const outflow of outflows) {
      items.push({
        account: walletAccount,
        currency: outflow.symbol,
        amount: outflow.amount.negated(),
      });
      items.push({
        account: defiAssets("Jupiter", "Swap"),
        currency: outflow.symbol,
        amount: outflow.amount,
      });
    }

    for (const inflow of inflows) {
      items.push({
        account: walletAccount,
        currency: inflow.symbol,
        amount: inflow.amount,
      });
      items.push({
        account: defiAssets("Jupiter", "Swap"),
        currency: inflow.symbol,
        amount: inflow.amount.negated(),
      });
    }

    // Fee
    if (tx.feePayer === ctx.address && tx.fee > 0) {
      await ctx.ensureCurrency("SOL", 9);
      items.push({
        account: chainFees("Solana"),
        currency: "SOL",
        amount: lamportsToSol(tx.fee),
      });
      items.push({
        account: walletAccount,
        currency: "SOL",
        amount: lamportsToSol(-tx.fee),
      });
    }

    const merged = mergeItemAccums(items);
    if (merged.length === 0) {
      return { type: "skip", reason: "No swap detected" };
    }

    const date = new Date(tx.timestamp * 1000).toISOString().split("T")[0];
    const spentStr = outflows.map(o => `${o.amount} ${o.symbol}`).join(", ") || "?";
    const receivedStr = inflows.map(i => `${i.amount} ${i.symbol}`).join(", ") || "?";

    const descriptionData: DescriptionData = {
      type: "sol-defi",
      protocol: "Jupiter",
      action: "swap",
      signature: tx.signature,
      summary: `Jupiter swap: ${spentStr} → ${receivedStr}`,
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
        "sol:handler": "jupiter",
      },
    };

    return { type: "entries", entries: [entry] };
  },
};
