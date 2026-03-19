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
