/**
 * Pure-JS Solana key derivation for browser-only mode.
 * Uses SLIP-0010 (Ed25519 hardened derivation) with @noble/curves and @scure/bip39.
 *
 * Derivation path: m/44'/501'/k'/0' (Phantom standard)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { base58 } from "@scure/base";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const ED25519_CURVE = "ed25519 seed";

export interface DerivedSolAddress {
  index: number;
  address: string;
}

/**
 * SLIP-0010 master key derivation for Ed25519.
 */
function slip0010MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode(ED25519_CURVE), seed);
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  };
}

/**
 * SLIP-0010 hardened child derivation for Ed25519.
 * Ed25519 only supports hardened derivation (index >= 0x80000000).
 */
function slip0010DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  // index must be hardened
  const hardenedIndex = index | 0x80000000;
  const data = new Uint8Array(37);
  data[0] = 0x00; // padding byte for private key
  data.set(parentKey, 1);
  data[33] = (hardenedIndex >>> 24) & 0xff;
  data[34] = (hardenedIndex >>> 16) & 0xff;
  data[35] = (hardenedIndex >>> 8) & 0xff;
  data[36] = hardenedIndex & 0xff;
  const I = hmac(sha512, parentChainCode, data);
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  };
}

/**
 * Derive a Solana address from a seed phrase using the Phantom standard path.
 * Path: m/44'/501'/accountIndex'/0'
 */
function deriveKey(seed: Uint8Array, accountIndex: number): Uint8Array {
  let { key, chainCode } = slip0010MasterKey(seed);
  // m/44'
  ({ key, chainCode } = slip0010DeriveChild(key, chainCode, 44));
  // m/44'/501'
  ({ key, chainCode } = slip0010DeriveChild(key, chainCode, 501));
  // m/44'/501'/accountIndex'
  ({ key, chainCode } = slip0010DeriveChild(key, chainCode, accountIndex));
  // m/44'/501'/accountIndex'/0'
  ({ key } = slip0010DeriveChild(key, chainCode, 0));
  return key;
}

/**
 * Get Ed25519 public key from private key bytes.
 */
function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(privateKey);
}

/**
 * Encode an Ed25519 public key as a Solana Base58 address.
 */
function encodeAddress(publicKey: Uint8Array): string {
  return base58.encode(publicKey);
}

/**
 * Derive multiple Solana addresses from a seed phrase.
 */
export function deriveSolAddresses(
  mnemonic: string,
  count: number,
  passphrase?: string,
  startIndex?: number,
): DerivedSolAddress[] {
  const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
  const start = startIndex ?? 0;
  const results: DerivedSolAddress[] = [];

  for (let i = start; i < start + count; i++) {
    const privateKey = deriveKey(seed, i);
    const publicKey = getPublicKey(privateKey);
    results.push({
      index: i,
      address: encodeAddress(publicKey),
    });
  }

  return results;
}

/**
 * Validate a Solana address (Base58, 32 bytes when decoded).
 */
export function validateSolAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    const decoded = base58.decode(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Detect the type of a Solana-related input.
 */
export function detectSolInputType(input: string): import("./types.js").SolInputDetection {
  const s = input.trim();
  if (!s) {
    return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
  }

  // Seed phrase detection
  const words = s.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
    const validCounts = [12, 15, 18, 21, 24];
    const wordCount = words.length;
    const hasValidCount = validCounts.includes(wordCount);
    const isValid = hasValidCount && validateMnemonic(s, english);
    return {
      input_type: "seed",
      is_private: true,
      valid: isValid,
      word_count: wordCount,
      description: `BIP39 Seed Phrase (${wordCount} words)`,
    };
  }

  // Base58 private key (64-byte keypair encoded, 88 chars)
  if (/^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(s)) {
    try {
      const decoded = base58.decode(s);
      if (decoded.length === 64) {
        return {
          input_type: "keypair",
          is_private: true,
          valid: true,
          word_count: null,
          description: "Solana Keypair (Base58)",
        };
      }
    } catch { /* not a valid keypair */ }
  }

  // Solana address
  if (validateSolAddress(s)) {
    return {
      input_type: "address",
      is_private: false,
      valid: true,
      word_count: null,
      description: "Solana Address",
    };
  }

  return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
