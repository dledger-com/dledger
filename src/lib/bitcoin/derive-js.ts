/**
 * Pure-JS Bitcoin key derivation for browser-only mode.
 * Uses audited @scure/@noble libraries — no WASM, no native deps.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { bech32, bech32m, base58check as createBase58check } from "@scure/base";
import { getPublicKey } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import type { PrivateKeyConversion, BtcInputDetection } from "./types.js";

const base58check = createBase58check(sha256);

// ---- Version byte constants ----

const VERSION = {
  xprv: 0x0488ade4, xpub: 0x0488b21e,
  yprv: 0x049d7878, ypub: 0x049d7cb2,
  zprv: 0x04b2430c, zpub: 0x04b24746,
  tprv: 0x04358394, tpub: 0x043587cf,
  uprv: 0x044a4e28, upub: 0x044a5262,
  vprv: 0x045f18bc, vpub: 0x045f1cf6,
} as const;

const PRIV_TO_PUB: Record<number, number> = {
  [VERSION.xprv]: VERSION.xpub,
  [VERSION.yprv]: VERSION.ypub,
  [VERSION.zprv]: VERSION.zpub,
  [VERSION.tprv]: VERSION.tpub,
  [VERSION.uprv]: VERSION.upub,
  [VERSION.vprv]: VERSION.vpub,
};

const PUB_TO_XPUB: Record<number, number> = {
  [VERSION.ypub]: VERSION.xpub,
  [VERSION.zpub]: VERSION.xpub,
  [VERSION.upub]: VERSION.tpub,
  [VERSION.vpub]: VERSION.tpub,
};

const BIP_FOR_VERSION: Record<number, number> = {
  [VERSION.xpub]: 44, [VERSION.xprv]: 44,
  [VERSION.ypub]: 49, [VERSION.yprv]: 49,
  [VERSION.zpub]: 84, [VERSION.zprv]: 84,
  [VERSION.tpub]: 44, [VERSION.tprv]: 44,
  [VERSION.upub]: 49, [VERSION.uprv]: 49,
  [VERSION.vpub]: 84, [VERSION.vprv]: 84,
};

const VERSION_NAME: Record<number, string> = {
  [VERSION.xpub]: "xpub", [VERSION.ypub]: "ypub", [VERSION.zpub]: "zpub",
  [VERSION.tpub]: "tpub", [VERSION.upub]: "upub", [VERSION.vpub]: "vpub",
};

// ---- Helpers ----

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
}

function writeU32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

/** Swap version bytes in a base58check-encoded extended key. */
function swapVersionBytes(key: string, newVersion: number): string {
  const decoded = base58check.decode(key);
  const buf = new Uint8Array(decoded);
  writeU32BE(buf, 0, newVersion);
  return base58check.encode(buf);
}

function getVersionFromKey(key: string): number {
  const decoded = base58check.decode(key);
  return readU32BE(decoded, 0);
}

function isTestnet(network?: string): boolean {
  return network === "testnet";
}

/** Convert BIP number to purpose-level version bytes. */
function pubVersionForBip(bip: number, testnet: boolean): number {
  if (testnet) {
    if (bip === 49) return VERSION.upub;
    if (bip === 84) return VERSION.vpub;
    return VERSION.tpub;
  }
  if (bip === 49) return VERSION.ypub;
  if (bip === 84) return VERSION.zpub;
  return VERSION.xpub;
}

// ---- Address encoding ----

function encodeP2PKH(pubkey: Uint8Array, testnet: boolean): string {
  const h = hash160(pubkey);
  const payload = new Uint8Array(21);
  payload[0] = testnet ? 0x6f : 0x00;
  payload.set(h, 1);
  return base58check.encode(payload);
}

function encodeP2SH(redeemScript: Uint8Array, testnet: boolean): string {
  const h = hash160(redeemScript);
  const payload = new Uint8Array(21);
  payload[0] = testnet ? 0xc4 : 0x05;
  payload.set(h, 1);
  return base58check.encode(payload);
}

function encodeP2WPKH(pubkey: Uint8Array, testnet: boolean): string {
  const h = hash160(pubkey);
  const words = bech32.toWords(h);
  return bech32.encode(testnet ? "tb" : "bc", [0, ...words]);
}

function encodeP2SH_P2WPKH(pubkey: Uint8Array, testnet: boolean): string {
  // OP_0 <20-byte-key-hash>
  const h = hash160(pubkey);
  const redeemScript = new Uint8Array(22);
  redeemScript[0] = 0x00; // OP_0
  redeemScript[1] = 0x14; // push 20 bytes
  redeemScript.set(h, 2);
  return encodeP2SH(redeemScript, testnet);
}

function encodeP2TR(pubkey: Uint8Array, testnet: boolean): string {
  // For P2TR, we need the x-only public key (32 bytes)
  // If compressed (33 bytes starting with 02/03), strip the prefix
  const xOnly = pubkey.length === 33 ? pubkey.slice(1) : pubkey;
  const words = bech32m.toWords(xOnly);
  return bech32m.encode(testnet ? "tb" : "bc", [1, ...words]);
}

// ---- Multi-index xpub derivation ----

export interface DerivedBtcXpub {
  index: number;
  xpub: string;
  keyType: string;
}

/**
 * Derive multiple account-level xpubs from a seed phrase.
 * Each xpub corresponds to m/{bip}'/{coinType}'/{i}' for i in [startIndex, startIndex+count).
 */
export function deriveMultiAccountXpubs(
  mnemonic: string,
  bip: number,
  passphrase: string,
  testnet: boolean,
  count: number,
  startIndex: number = 0,
): DerivedBtcXpub[] {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  const master = HDKey.fromMasterSeed(seed);
  const coinType = testnet ? 1 : 0;
  const pubVersion = pubVersionForBip(bip, testnet);
  const keyType = VERSION_NAME[pubVersion] ?? "xpub";
  const results: DerivedBtcXpub[] = [];

  for (let i = startIndex; i < startIndex + count; i++) {
    const path = `m/${bip}'/${coinType}'/${i}'`;
    const accountKey = master.derive(path);
    if (!accountKey.publicKey || !accountKey.chainCode) {
      throw new Error(`Failed to derive account key at index ${i}`);
    }
    const xpubStr = accountKey.publicExtendedKey;
    const finalKey = pubVersion !== VERSION.xpub && pubVersion !== VERSION.tpub
      ? swapVersionBytes(xpubStr, pubVersion)
      : (testnet ? swapVersionBytes(xpubStr, VERSION.tpub) : xpubStr);
    results.push({ index: i, xpub: finalKey, keyType });
  }

  return results;
}

// ---- Public API ----

/**
 * Convert a private key input (seed phrase, WIF, xprv) to its public equivalent.
 */
export function convertPrivateKeyJs(
  input: string,
  bip?: number,
  passphrase?: string,
  network?: string,
): PrivateKeyConversion {
  const trimmed = input.trim();
  const testnet = isTestnet(network);

  // Try seed phrase
  const words = trimmed.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.length % 3 === 0) {
    if (validateMnemonic(trimmed, english)) {
      return convertSeedPhrase(trimmed, bip ?? 84, passphrase ?? "", testnet);
    }
  }

  // Try WIF
  try {
    const result = convertWIF(trimmed, testnet);
    if (result) return result;
  } catch { /* not a WIF */ }

  // Try extended private key
  try {
    const result = convertXprv(trimmed);
    if (result) return result;
  } catch { /* not an xprv */ }

  throw new Error("Unrecognized private key format");
}

function convertSeedPhrase(
  mnemonic: string,
  bip: number,
  passphrase: string,
  testnet: boolean,
): PrivateKeyConversion {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);

  // Derive using the appropriate BIP purpose path
  // m/purpose'/coin_type'/account'
  const coinType = testnet ? 1 : 0;
  const path = `m/${bip}'/${coinType}'/0'`;

  const master = HDKey.fromMasterSeed(seed);
  const accountKey = master.derive(path);

  if (!accountKey.publicKey || !accountKey.chainCode) {
    throw new Error("Failed to derive account key");
  }

  // Encode as the appropriate xpub variant
  const pubVersion = pubVersionForBip(bip, testnet);
  // HDKey uses xpub version by default; re-encode with correct version if needed
  const xpubStr = accountKey.publicExtendedKey;
  const finalKey = pubVersion !== VERSION.xpub && pubVersion !== VERSION.tpub
    ? swapVersionBytes(xpubStr, pubVersion)
    : (testnet ? swapVersionBytes(xpubStr, VERSION.tpub) : xpubStr);

  const keyType = VERSION_NAME[pubVersion] ?? "xpub";

  return {
    input_type: "seed",
    public_result: { kind: "Xpub", xpub: finalKey, key_type: keyType },
    network: testnet ? "testnet" : "mainnet",
    suggested_bip: bip,
  };
}

function convertWIF(wif: string, testnet: boolean): PrivateKeyConversion | null {
  const decoded = base58check.decode(wif);
  // WIF format: version(1) + privkey(32) + [compressed flag(1)]
  const version = decoded[0];
  if (version !== 0x80 && version !== 0xef) return null; // not a WIF

  const isCompressed = decoded.length === 34 && decoded[33] === 0x01;
  const privKeyBytes = decoded.slice(1, 33);
  const pubkey = getPublicKey(privKeyBytes, isCompressed) as Uint8Array;
  const wifTestnet = version === 0xef;

  // Generate the most appropriate address
  let address: string;
  if (isCompressed) {
    // Default to P2WPKH (native segwit) for compressed keys
    address = encodeP2WPKH(pubkey, wifTestnet);
  } else {
    // Uncompressed keys can only do P2PKH
    address = encodeP2PKH(pubkey, wifTestnet);
  }

  return {
    input_type: "wif",
    public_result: { kind: "Address", address },
    network: wifTestnet ? "testnet" : "mainnet",
    suggested_bip: isCompressed ? 84 : 44,
  };
}

function convertXprv(xprv: string): PrivateKeyConversion | null {
  const decoded = base58check.decode(xprv);
  const version = readU32BE(decoded, 0);

  const pubVersion = PRIV_TO_PUB[version];
  if (pubVersion === undefined) return null; // not an xprv variant

  const bip = BIP_FOR_VERSION[version] ?? 44;
  const testnet = version === VERSION.tprv || version === VERSION.uprv || version === VERSION.vprv;

  // Convert version bytes to xpub-compatible for HDKey parsing
  const xpubVersion = testnet ? VERSION.tprv : VERSION.xprv;
  const keyForParsing = version !== xpubVersion ? swapVersionBytes(xprv, xpubVersion) : xprv;

  const bitcoinVersions = testnet
    ? { private: VERSION.tprv, public: VERSION.tpub }
    : { private: VERSION.xprv, public: VERSION.xpub };

  const hdkey = HDKey.fromExtendedKey(keyForParsing, bitcoinVersions);
  const xpubStr = hdkey.publicExtendedKey;

  // Re-encode with the correct pub version (ypub/zpub/etc.)
  const finalKey = pubVersion !== bitcoinVersions.public
    ? swapVersionBytes(xpubStr, pubVersion)
    : xpubStr;

  const keyType = VERSION_NAME[pubVersion] ?? "xpub";

  return {
    input_type: "xprv",
    public_result: { kind: "Xpub", xpub: finalKey, key_type: keyType },
    network: testnet ? "testnet" : "mainnet",
    suggested_bip: bip,
  };
}

/**
 * Derive Bitcoin addresses from an extended public key.
 */
export function deriveBtcAddressesJs(
  xpub: string,
  bip: number,
  change: number,
  fromIndex: number,
  count: number,
  network: "mainnet" | "testnet",
): string[] {
  const testnet = network === "testnet";

  // Decode to get version, then normalize to xpub/tpub for HDKey
  const version = getVersionFromKey(xpub);
  const xpubNormalized = PUB_TO_XPUB[version]
    ? swapVersionBytes(xpub, PUB_TO_XPUB[version])
    : xpub;

  const bitcoinVersions = testnet
    ? { private: VERSION.tprv, public: VERSION.tpub }
    : { private: VERSION.xprv, public: VERSION.xpub };

  const parent = HDKey.fromExtendedKey(xpubNormalized, bitcoinVersions);
  const addresses: string[] = [];

  for (let i = fromIndex; i < fromIndex + count; i++) {
    const child = parent.deriveChild(change).deriveChild(i);
    const pubkey = child.publicKey;
    if (!pubkey) throw new Error(`Failed to derive child key at index ${i}`);

    let addr: string;
    switch (bip) {
      case 44:
        addr = encodeP2PKH(pubkey, testnet);
        break;
      case 49:
        addr = encodeP2SH_P2WPKH(pubkey, testnet);
        break;
      case 84:
        addr = encodeP2WPKH(pubkey, testnet);
        break;
      case 86:
        addr = encodeP2TR(pubkey, testnet);
        break;
      default:
        addr = encodeP2WPKH(pubkey, testnet);
    }
    addresses.push(addr);
  }

  return addresses;
}

/**
 * Enhanced browser-based input type detection using @scure libraries.
 * Provides proper checksum/wordlist validation instead of regex-only.
 */
export function detectBtcInputTypeJs(input: string): BtcInputDetection {
  const s = input.trim();
  if (!s) {
    return { input_type: "unknown", is_private: false, network: "unknown", suggested_bip: null, description: "", valid: false, word_count: null, invalid_words: null };
  }

  // Seed phrase detection with proper validation
  const words = s.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
    const validCounts = [12, 15, 18, 21, 24];
    const wordCount = words.length;
    const hasValidCount = validCounts.includes(wordCount);

    // Check individual words against BIP39 wordlist
    const invalidWords = words.filter(w => !english.includes(w));

    // Full validation with checksum
    const isValid = hasValidCount && invalidWords.length === 0 && validateMnemonic(s, english);

    return {
      input_type: "seed",
      is_private: true,
      network: "unknown",
      suggested_bip: 84,
      description: `BIP39 Seed Phrase (${wordCount} words)`,
      valid: isValid,
      word_count: wordCount,
      invalid_words: invalidWords.length > 0 ? invalidWords : null,
    };
  }

  // WIF detection with base58check validation
  if (/^[5KLcn9][1-9A-HJ-NP-Za-km-z]{49,52}$/.test(s)) {
    let valid = false;
    let network: "mainnet" | "testnet" | "unknown" = "unknown";
    try {
      const decoded = base58check.decode(s);
      const version = decoded[0];
      if (version === 0x80) { valid = true; network = "mainnet"; }
      else if (version === 0xef) { valid = true; network = "testnet"; }
    } catch { /* invalid base58check */ }
    return {
      input_type: "wif",
      is_private: true,
      network,
      suggested_bip: null,
      description: "WIF Private Key",
      valid,
      word_count: null,
      invalid_words: null,
    };
  }

  // Extended private key with version byte validation
  if (/^[xyztuvXYZTUV]prv[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(s)) {
    let valid = false;
    let network: "mainnet" | "testnet" | "unknown" = "unknown";
    let suggestedBip: number | null = null;
    let keyTypeName = "xprv";
    try {
      const decoded = base58check.decode(s);
      const version = readU32BE(decoded, 0);
      if (PRIV_TO_PUB[version] !== undefined) {
        valid = true;
        suggestedBip = BIP_FOR_VERSION[version] ?? null;
        const testnet = version === VERSION.tprv || version === VERSION.uprv || version === VERSION.vprv;
        network = testnet ? "testnet" : "mainnet";
        const prefix = s.slice(0, 4);
        keyTypeName = prefix;
      }
    } catch { /* invalid base58check */ }
    return {
      input_type: keyTypeName as BtcInputDetection["input_type"],
      is_private: true,
      network,
      suggested_bip: suggestedBip,
      description: `Extended Private Key${suggestedBip ? ` (BIP${suggestedBip})` : ""}`,
      valid,
      word_count: null,
      invalid_words: null,
    };
  }

  // Not a private key type — return null to let caller handle public types
  return { input_type: "unknown", is_private: false, network: "unknown", suggested_bip: null, description: "", valid: false, word_count: null, invalid_words: null };
}
