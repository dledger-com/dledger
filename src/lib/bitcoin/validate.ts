const BTC_ADDRESS_RE = /^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[qp][a-z0-9]{38,58}|[mn2][1-9A-HJ-NP-Za-km-z]{25,34}|tb1[qp][a-z0-9]{38,58})$/;
const BTC_XPUB_RE = /^[xyzXYZ]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;

// Also match tpub/upub/vpub for testnet
const BTC_EXTENDED_KEY_RE = /^[xyztuvXYZTUV]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;

export function isValidBtcAddress(address: string): boolean {
  return BTC_ADDRESS_RE.test(address);
}

export function isValidBtcExtendedKey(key: string): boolean {
  return BTC_EXTENDED_KEY_RE.test(key);
}

export function detectKeyType(key: string): { type: "xpub" | "ypub" | "zpub" | "tpub" | "upub" | "vpub" | "unknown"; suggestedBip: number; network: "mainnet" | "testnet" } {
  if (key.startsWith("xpub")) return { type: "xpub", suggestedBip: 44, network: "mainnet" };
  if (key.startsWith("ypub")) return { type: "ypub", suggestedBip: 49, network: "mainnet" };
  if (key.startsWith("zpub")) return { type: "zpub", suggestedBip: 84, network: "mainnet" };
  if (key.startsWith("tpub")) return { type: "tpub", suggestedBip: 44, network: "testnet" };
  if (key.startsWith("upub")) return { type: "upub", suggestedBip: 49, network: "testnet" };
  if (key.startsWith("vpub")) return { type: "vpub", suggestedBip: 84, network: "testnet" };
  return { type: "unknown", suggestedBip: 84, network: "mainnet" };
}

export function detectAddressNetwork(address: string): "mainnet" | "testnet" | "unknown" {
  if (address.startsWith("1") || address.startsWith("3") || address.startsWith("bc1")) return "mainnet";
  if (address.startsWith("m") || address.startsWith("n") || address.startsWith("2") || address.startsWith("tb1")) return "testnet";
  return "unknown";
}

export const BTC_WIF_RE = /^[5KLcn9][1-9A-HJ-NP-Za-km-z]{49,52}$/;
export const BTC_EXTENDED_PRIV_RE = /^[xyztuvXYZTUV]prv[1-9A-HJ-NP-Za-km-z]{100,112}$/;
export const BTC_SEED_RE = /^([a-z]+\s+){11,23}[a-z]+$/;

export type QuickInputType = "address" | "xpub" | "wif" | "xprv" | "seed" | "unknown";

export interface QuickDetection {
  type: QuickInputType;
  isPrivate: boolean;
  description: string;
}

/**
 * Fast regex-based detection of Bitcoin input type.
 * No async, no Rust call — suitable for reactive `$derived`.
 * Does NOT validate checksums or wordlists.
 */
export function detectInputType(input: string): QuickDetection {
  const s = input.trim();
  if (!s) return { type: "unknown", isPrivate: false, description: "" };

  // Address
  if (isValidBtcAddress(s)) {
    return { type: "address", isPrivate: false, description: "Bitcoin Address" };
  }

  // Extended public key
  if (isValidBtcExtendedKey(s)) {
    const info = detectKeyType(s);
    const bipDesc: Record<number, string> = {
      44: "Legacy (BIP44)",
      49: "Wrapped SegWit (BIP49)",
      84: "Native SegWit (BIP84)",
    };
    return {
      type: "xpub",
      isPrivate: false,
      description: `Extended Public Key — ${bipDesc[info.suggestedBip] ?? `BIP${info.suggestedBip}`}`,
    };
  }

  // WIF private key
  if (BTC_WIF_RE.test(s)) {
    return { type: "wif", isPrivate: true, description: "WIF Private Key" };
  }

  // Extended private key
  if (BTC_EXTENDED_PRIV_RE.test(s)) {
    const prefix = s.slice(0, 4);
    const bipMap: Record<string, string> = {
      xprv: "Legacy (BIP44)", yprv: "Wrapped SegWit (BIP49)", zprv: "Native SegWit (BIP84)",
      tprv: "Legacy (BIP44)", uprv: "Wrapped SegWit (BIP49)", vprv: "Native SegWit (BIP84)",
    };
    return { type: "xprv", isPrivate: true, description: `Extended Private Key — ${bipMap[prefix] ?? prefix}` };
  }

  // Seed phrase
  if (BTC_SEED_RE.test(s)) {
    const wordCount = s.split(/\s+/).length;
    return { type: "seed", isPrivate: true, description: `Seed Phrase (${wordCount} words)` };
  }

  return { type: "unknown", isPrivate: false, description: "" };
}
