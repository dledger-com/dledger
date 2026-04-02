import Decimal from "decimal.js-light";
import type { ItemAccum } from "../handlers/item-builder.js";
import { walletAssets, walletExternal, chainFees } from "../accounts/paths.js";
import type { BtcApiTx } from "./types.js";
import type { BtcClassification } from "./classify.js";

const SATS_PER_BTC = new Decimal("100000000");

/** Convert satoshis to BTC as a Decimal. */
export function satsToBtc(sats: number): Decimal {
  return new Decimal(sats).dividedBy(SATS_PER_BTC);
}

/** Truncate an address for use in descriptions/account paths (first 8 chars + last 4). */
export function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export function accountPathAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}-${addr.slice(-4)}`;
}

/**
 * Build journal line items from a classified Bitcoin transaction.
 *
 * Uses walletAssets("Bitcoin", label) for wallet accounts,
 * walletExternal("Bitcoin", accountPathAddr) for external counterparties,
 * and chainFees("Bitcoin") for fees.
 *
 * All items sum to zero per currency (double-entry invariant).
 */
export function buildBtcItems(
  tx: BtcApiTx,
  classification: BtcClassification,
  addressToWallet: Map<string, string>,
): ItemAccum[] {
  const items: ItemAccum[] = [];

  switch (classification.type) {
    case "receive": {
      // Wallet balances increase
      for (const [walletLabel, satsDelta] of classification.walletChanges) {
        if (satsDelta <= 0) continue;
        items.push({
          account: walletAssets("Bitcoin", walletLabel),
          currency: "BTC",
          amount: satsToBtc(satsDelta),
        });
      }

      // External source — find first external input address
      const externalInputAddrs = tx.vin
        .filter(
          (v) =>
            v.prevout &&
            !addressToWallet.has(v.prevout.scriptpubkey_address),
        )
        .map((v) => v.prevout!.scriptpubkey_address);

      const counterparty = externalInputAddrs[0] ?? "unknown";
      const totalReceived = satsToBtc(classification.externalReceived);
      items.push({
        account: walletExternal("Bitcoin", accountPathAddr(counterparty)),
        currency: "BTC",
        amount: totalReceived.negated(),
      });
      break;
    }

    case "send": {
      // Net wallet changes (already negative, includes fee)
      for (const [walletLabel, satsDelta] of classification.walletChanges) {
        if (satsDelta === 0) continue;
        items.push({
          account: walletAssets("Bitcoin", walletLabel),
          currency: "BTC",
          amount: satsToBtc(satsDelta),
        });
      }

      // External recipients
      const recipient = classification.externalRecipients[0] ?? "unknown";
      items.push({
        account: walletExternal("Bitcoin", accountPathAddr(recipient)),
        currency: "BTC",
        amount: satsToBtc(classification.externalSent),
      });

      // Fee
      if (classification.fee > 0) {
        items.push({
          account: chainFees("Bitcoin"),
          currency: "BTC",
          amount: satsToBtc(classification.fee),
        });
      }
      break;
    }

    case "consolidation":
    case "self": {
      // Net wallet changes (sum = -fee)
      for (const [walletLabel, satsDelta] of classification.walletChanges) {
        if (satsDelta === 0) continue;
        items.push({
          account: walletAssets("Bitcoin", walletLabel),
          currency: "BTC",
          amount: satsToBtc(satsDelta),
        });
      }

      // Fee expense
      if (classification.fee > 0) {
        items.push({
          account: chainFees("Bitcoin"),
          currency: "BTC",
          amount: satsToBtc(classification.fee),
        });
      }
      break;
    }
  }

  return items;
}
