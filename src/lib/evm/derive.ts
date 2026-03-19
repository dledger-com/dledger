/**
 * Pure-JS EVM address derivation from seed phrases and private keys.
 * Uses audited @scure/@noble libraries — no WASM, no native deps.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { getPublicKey, Point } from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---- Types ----

export interface DerivedEvmAddress {
  index: number;
  address: string; // EIP-55 checksummed
}

export type EvmInputType = "address" | "private_key" | "seed" | "xpub" | "unknown";

export interface EvmInputDetection {
  type: EvmInputType;
  isPrivate: boolean;
  description: string;
}

export interface EvmSeedValidation {
  valid: boolean;
  wordCount: number;
  invalidWords: string[];
}

// ---- Regexes ----

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_PRIVKEY_RE = /^(0x)?[a-fA-F0-9]{64}$/;
const SEED_RE = /^([a-z]+\s+){11,23}[a-z]+$/;
const XPUB_RE = /^xpub[1-9A-HJ-NP-Za-km-z]{100,112}$/;

// ---- Public API ----

/**
 * Fast regex-based detection of EVM input type.
 * No async — suitable for reactive `$derived`.
 */
export function detectEvmInputType(input: string): EvmInputDetection {
  const s = input.trim();
  if (!s) return { type: "unknown", isPrivate: false, description: "" };

  // Address (check first — 0x + 40 hex is a subset of 64 hex)
  if (EVM_ADDRESS_RE.test(s)) {
    return { type: "address", isPrivate: false, description: "EVM Address" };
  }

  // Raw private key (64 hex chars, optionally 0x-prefixed)
  if (EVM_PRIVKEY_RE.test(s)) {
    return { type: "private_key", isPrivate: true, description: "Private Key (hex)" };
  }

  // Seed phrase
  if (SEED_RE.test(s)) {
    const wordCount = s.split(/\s+/).length;
    return { type: "seed", isPrivate: true, description: `Seed Phrase (${wordCount} words)` };
  }

  // Extended public key (xpub)
  if (XPUB_RE.test(s)) {
    return { type: "xpub", isPrivate: false, description: "Extended Public Key (xpub)" };
  }

  return { type: "unknown", isPrivate: false, description: "" };
}

/**
 * Deep validation of a BIP39 seed phrase using the English wordlist.
 */
export function validateEvmSeedPhrase(input: string): EvmSeedValidation {
  const s = input.trim();
  const words = s.split(/\s+/);
  const wordCount = words.length;
  const invalidWords = words.filter(w => !english.includes(w));

  const valid = invalidWords.length === 0 && validateMnemonic(s, english);
  return { valid, wordCount, invalidWords };
}

/**
 * Derive an EVM address from a seed phrase, raw private key hex, or xpub.
 * Returns an EIP-55 checksummed address. Throws on invalid input.
 */
export function deriveEvmAddress(input: string, passphrase?: string): string {
  const s = input.trim();

  // Seed phrase path
  if (SEED_RE.test(s)) {
    const seed = mnemonicToSeedSync(s, passphrase ?? "");
    const master = HDKey.fromMasterSeed(seed);
    const child = master.derive("m/44'/60'/0'/0/0");
    if (!child.privateKey) throw new Error("Failed to derive private key from seed");
    return pubkeyToAddress(child.privateKey);
  }

  // Private key hex path
  if (EVM_PRIVKEY_RE.test(s)) {
    const hex = s.startsWith("0x") ? s.slice(2) : s;
    const privKey = hexToBytes(hex);
    return pubkeyToAddress(privKey);
  }

  // Extended public key (xpub) path
  if (XPUB_RE.test(s)) {
    return deriveEvmAddressFromXpub(s);
  }

  throw new Error("Input is not a seed phrase, private key, or xpub");
}

/**
 * Derive an EVM address from an xpub (expected to be derived at m/44'/60'/0').
 * Derives child 0/0 and computes the keccak address.
 */
export function deriveEvmAddressFromXpub(xpub: string): string {
  const versions = { private: 0x0488ade4, public: 0x0488b21e };
  const parent = HDKey.fromExtendedKey(xpub, versions);
  const child = parent.deriveChild(0).deriveChild(0);
  if (!child.publicKey) throw new Error("Failed to derive public key from xpub");

  // Decompress public key → uncompressed 65 bytes (0x04 + x + y)
  const uncompressed = Point.fromBytes(child.publicKey).toBytes(false);
  // Keccak hash of the 64-byte x||y (skip 0x04 prefix), last 20 bytes = address
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = hash.slice(-20);
  return toChecksumAddress(bytesToHex(addrBytes));
}

/**
 * EIP-55 mixed-case checksum encoding for an Ethereum address.
 */
export function toChecksumAddress(rawHex: string): string {
  const addr = rawHex.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)));

  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = parseInt(hash[i], 16);
    checksummed += nibble >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return checksummed;
}

/**
 * Derive multiple EVM addresses from a seed phrase at sequential HD indexes.
 * Path: m/44'/60'/0'/0/{i} for each index.
 */
export function deriveEvmAddressesFromSeed(
  mnemonic: string,
  count: number,
  passphrase?: string,
  startIndex = 0,
): DerivedEvmAddress[] {
  const s = mnemonic.trim();
  const seed = mnemonicToSeedSync(s, passphrase ?? "");
  const master = HDKey.fromMasterSeed(seed);
  const results: DerivedEvmAddress[] = [];
  for (let i = startIndex; i < startIndex + count; i++) {
    const child = master.derive(`m/44'/60'/0'/0/${i}`);
    if (!child.privateKey) throw new Error(`Failed to derive key at index ${i}`);
    results.push({ index: i, address: pubkeyToAddress(child.privateKey) });
  }
  return results;
}

/**
 * Derive multiple EVM addresses from an xpub at sequential child indexes.
 * Expects xpub derived at m/44'/60'/0'. Derives 0/{i} for each index.
 */
export function deriveEvmAddressesFromXpub(
  xpub: string,
  count: number,
  startIndex = 0,
): DerivedEvmAddress[] {
  const versions = { private: 0x0488ade4, public: 0x0488b21e };
  const parent = HDKey.fromExtendedKey(xpub, versions);
  const change = parent.deriveChild(0);
  const results: DerivedEvmAddress[] = [];
  for (let i = startIndex; i < startIndex + count; i++) {
    const child = change.deriveChild(i);
    if (!child.publicKey) throw new Error(`Failed to derive public key at index ${i}`);
    const uncompressed = Point.fromBytes(child.publicKey).toBytes(false);
    const hash = keccak_256(uncompressed.slice(1));
    const addrBytes = hash.slice(-20);
    results.push({ index: i, address: toChecksumAddress(bytesToHex(addrBytes)) });
  }
  return results;
}

// ---- Helpers ----

function pubkeyToAddress(privKey: Uint8Array): string {
  // Uncompressed public key (65 bytes: 0x04 + x + y)
  const pubUncompressed = getPublicKey(privKey, false) as Uint8Array;
  // Drop the 0x04 prefix, hash the 64-byte x||y
  const hash = keccak_256(pubUncompressed.slice(1));
  // Last 20 bytes = address
  const addrBytes = hash.slice(-20);
  return toChecksumAddress(bytesToHex(addrBytes));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
