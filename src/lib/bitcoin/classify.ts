import type { BtcApiTx } from "./types.js";

export type BtcTxType = "send" | "receive" | "self" | "consolidation";

export interface BtcClassification {
  type: BtcTxType;
  /** Net amount change per wallet label (satoshis) */
  walletChanges: Map<string, number>;
  /** Amount sent to external addresses (satoshis) */
  externalSent: number;
  /** External recipient addresses (for description) */
  externalRecipients: string[];
  /** Fee (satoshis), only attributed when we own inputs */
  fee: number;
  /** Total amount received from external sources (satoshis) */
  externalReceived: number;
}

/**
 * Classify a Bitcoin transaction based on which inputs/outputs belong to tracked addresses.
 *
 * @param tx - The raw transaction from the API
 * @param ownedAddresses - Set of all tracked addresses across all wallets
 * @param addressToWallet - Maps each address to its wallet label
 */
export function classifyBtcTx(
  tx: BtcApiTx,
  ownedAddresses: Set<string>,
  addressToWallet: Map<string, string>,
): BtcClassification {
  // Analyze inputs
  const ownedInputs = tx.vin.filter(
    (v) => v.prevout && ownedAddresses.has(v.prevout.scriptpubkey_address),
  );

  // Analyze outputs
  const ownedOutputs = tx.vout.filter(
    (v) => v.scriptpubkey_address && ownedAddresses.has(v.scriptpubkey_address),
  );
  const externalOutputs = tx.vout.filter(
    (v) => v.scriptpubkey_address && !ownedAddresses.has(v.scriptpubkey_address),
  );

  const totalOwnedOutputValue = ownedOutputs.reduce((sum, v) => sum + v.value, 0);
  const totalExternalOutputValue = externalOutputs.reduce((sum, v) => sum + v.value, 0);

  // Calculate net changes per wallet
  const walletChanges = new Map<string, number>();

  // Deduct inputs from wallets
  for (const vin of ownedInputs) {
    if (!vin.prevout) continue;
    const label = addressToWallet.get(vin.prevout.scriptpubkey_address) ?? "Unknown";
    walletChanges.set(label, (walletChanges.get(label) ?? 0) - vin.prevout.value);
  }

  // Add outputs to wallets
  for (const vout of ownedOutputs) {
    if (!vout.scriptpubkey_address) continue;
    const label = addressToWallet.get(vout.scriptpubkey_address) ?? "Unknown";
    walletChanges.set(label, (walletChanges.get(label) ?? 0) + vout.value);
  }

  const externalRecipients = externalOutputs
    .map((v) => v.scriptpubkey_address)
    .filter(Boolean);

  // Classification logic
  if (ownedInputs.length === 0) {
    // No owned inputs — we're receiving
    return {
      type: "receive",
      walletChanges,
      externalSent: 0,
      externalRecipients: [],
      fee: 0, // sender pays the fee
      externalReceived: totalOwnedOutputValue,
    };
  }

  if (externalOutputs.length === 0) {
    // All outputs go to owned addresses
    const walletLabels = new Set<string>();
    for (const vout of ownedOutputs) {
      if (vout.scriptpubkey_address) {
        walletLabels.add(addressToWallet.get(vout.scriptpubkey_address) ?? "Unknown");
      }
    }
    for (const vin of ownedInputs) {
      if (vin.prevout) {
        walletLabels.add(addressToWallet.get(vin.prevout.scriptpubkey_address) ?? "Unknown");
      }
    }

    if (walletLabels.size <= 1) {
      return {
        type: "consolidation",
        walletChanges,
        externalSent: 0,
        externalRecipients: [],
        fee: tx.fee,
        externalReceived: 0,
      };
    } else {
      return {
        type: "self",
        walletChanges,
        externalSent: 0,
        externalRecipients: [],
        fee: tx.fee,
        externalReceived: 0,
      };
    }
  }

  // Has external outputs — send
  return {
    type: "send",
    walletChanges,
    externalSent: totalExternalOutputValue,
    externalRecipients,
    fee: tx.fee,
    externalReceived: 0,
  };
}
