import Decimal from "decimal.js-light";
import type { HandlerResult, HandlerEntry } from "../../handlers/types.js";
import type { ItemAccum } from "../../handlers/item-builder.js";
import { mergeItemAccums } from "../../handlers/item-builder.js";
import { walletAssets, walletExternal, chainFees } from "../../accounts/paths.js";
import { renderDescription, solTransferDescription, type DescriptionData } from "../../types/description-data.js";
import type { SolTxGroup, SolTokenTransfer } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";

const LAMPORTS_PER_SOL = new Decimal("1000000000");

/** Known rent-exempt program IDs (ATA creation, etc.) */
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Convert lamports to SOL. */
export function lamportsToSol(lamports: number): Decimal {
  return new Decimal(lamports).dividedBy(LAMPORTS_PER_SOL);
}

/** Truncate an address for use in descriptions/account paths. */
export function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}-${addr.slice(-4)}`;
}

/**
 * Generic Solana handler (score: 1).
 * Handles SOL native transfers, SPL token transfers, and fees.
 */
export const genericSolanaHandler: SolanaHandler = {
  id: "generic-solana",
  name: "Generic Solana",
  description: "Handles basic SOL transfers, SPL token transfers, and transaction fees",

  match(tx: SolTxGroup): number {
    // Skip failed transactions
    if (tx.status === "failed") return 0;
    return 1;
  },

  async process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult> {
    if (tx.status === "failed") {
      return { type: "skip", reason: "Failed transaction" };
    }

    const items: ItemAccum[] = [];
    const walletAccount = walletAssets("Solana", ctx.label);

    // Check if this is an ATA creation (rent-exempt deposit) only
    const isAtaCreation = tx.instructions.some(ix => ix.programId === ATA_PROGRAM)
      && tx.nativeTransfers.length <= 2
      && tx.tokenTransfers.length === 0;

    // Process native SOL transfers
    let netSolLamports = 0;
    const externalAddresses = new Set<string>();
    let direction: "sent" | "received" | "self" = "self";

    for (const nt of tx.nativeTransfers) {
      if (nt.from === ctx.address && nt.to !== ctx.address) {
        netSolLamports -= nt.amount;
        externalAddresses.add(nt.to);
      } else if (nt.to === ctx.address && nt.from !== ctx.address) {
        netSolLamports += nt.amount;
        externalAddresses.add(nt.from);
      }
      // Self-transfers are ignored in the net calculation
    }

    // Determine direction
    if (netSolLamports > 0) direction = "received";
    else if (netSolLamports < 0) direction = "sent";

    // Add SOL items (excluding fee, which is handled separately)
    if (netSolLamports !== 0 && !isAtaCreation) {
      await ctx.ensureCurrency("SOL", 9);

      items.push({
        account: walletAccount,
        currency: "SOL",
        amount: lamportsToSol(netSolLamports),
      });

      // Counterparty
      const counterpartyAddr = Array.from(externalAddresses)[0] ?? "unknown";
      items.push({
        account: walletExternal("Solana", shortAddr(counterpartyAddr)),
        currency: "SOL",
        amount: lamportsToSol(-netSolLamports),
      });
    }

    // Process SPL token transfers
    const tokenFlows = aggregateTokenFlows(tx.tokenTransfers, ctx.address);
    for (const [mint, flow] of tokenFlows) {
      const symbol = flow.tokenSymbol ?? mint.slice(0, 6);
      await ctx.ensureCurrency(symbol, flow.decimals, mint);

      const tokenAmount = new Decimal(flow.netAmount);
      if (tokenAmount.isZero()) continue;

      items.push({
        account: walletAccount,
        currency: symbol,
        amount: tokenAmount,
      });

      const counterpartyAddr = flow.counterparties[0] ?? "unknown";
      items.push({
        account: walletExternal("Solana", shortAddr(counterpartyAddr)),
        currency: symbol,
        amount: tokenAmount.negated(),
      });

      if (tokenAmount.greaterThan(0)) direction = "received";
      else if (tokenAmount.lessThan(0)) direction = "sent";
    }

    // Transaction fee
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
      if (isAtaCreation && tx.fee > 0) {
        // ATA creation with only rent/fee — still record the fee
        await ctx.ensureCurrency("SOL", 9);
        const feeItems: ItemAccum[] = [
          { account: chainFees("Solana"), currency: "SOL", amount: lamportsToSol(tx.fee) },
          { account: walletAccount, currency: "SOL", amount: lamportsToSol(-tx.fee) },
        ];
        return buildEntry(tx, ctx, feeItems, "self");
      }
      return { type: "skip", reason: "No meaningful transfers" };
    }

    return buildEntry(tx, ctx, merged, direction);
  },
};

// ---- Helpers ----

interface TokenFlow {
  netAmount: string;
  decimals: number;
  tokenSymbol?: string;
  counterparties: string[];
}

function aggregateTokenFlows(
  transfers: SolTokenTransfer[],
  walletAddress: string,
): Map<string, TokenFlow> {
  const flows = new Map<string, TokenFlow>();

  for (const t of transfers) {
    const isOutgoing = t.from === walletAddress;
    const isIncoming = t.to === walletAddress;
    if (!isOutgoing && !isIncoming) continue;

    let flow = flows.get(t.mint);
    if (!flow) {
      flow = { netAmount: "0", decimals: t.decimals, tokenSymbol: t.tokenSymbol, counterparties: [] };
      flows.set(t.mint, flow);
    }

    const rawAmount = new Decimal(t.amount).dividedBy(new Decimal(10).pow(t.decimals));
    const signedAmount = isOutgoing ? rawAmount.negated() : rawAmount;
    flow.netAmount = new Decimal(flow.netAmount).plus(signedAmount).toString();
    flow.tokenSymbol = flow.tokenSymbol || t.tokenSymbol;

    const counterparty = isOutgoing ? t.to : t.from;
    if (counterparty && !flow.counterparties.includes(counterparty)) {
      flow.counterparties.push(counterparty);
    }
  }

  return flows;
}

function buildEntry(
  tx: SolTxGroup,
  ctx: SolanaHandlerContext,
  items: ItemAccum[],
  direction: "sent" | "received" | "self",
): HandlerResult {
  const date = new Date(tx.timestamp * 1000).toISOString().split("T")[0];
  const counterpartyAddr = direction === "sent"
    ? tx.nativeTransfers.find(nt => nt.from === ctx.address && nt.to !== ctx.address)?.to
    : tx.nativeTransfers.find(nt => nt.to === ctx.address && nt.from !== ctx.address)?.from;

  const descriptionData: DescriptionData = solTransferDescription(direction, tx.signature, {
    counterparty: counterpartyAddr ? shortAddr(counterpartyAddr) : undefined,
  });

  const description = renderDescription(descriptionData);

  const entry: HandlerEntry = {
    entry: {
      date,
      description,
      description_data: JSON.stringify(descriptionData),
      status: "confirmed",
      source: `solana:${tx.signature}`,
      voided_by: null,
    },
    items: items.map(item => ({
      account_id: item.account, // Will be resolved by sync pipeline
      currency: item.currency,
      amount: item.amount.toString(),
      lot_id: null,
    })),
    metadata: {
      "sol:signature": tx.signature,
      "sol:slot": String(tx.slot),
      "sol:timestamp": String(tx.timestamp),
      "sol:fee_lamports": String(tx.fee),
      "sol:fee_payer": tx.feePayer,
    },
  };

  if (tx.type) entry.metadata["sol:type"] = tx.type;
  if (tx.source) entry.metadata["sol:source"] = tx.source;

  return { type: "entries", entries: [entry] };
}
