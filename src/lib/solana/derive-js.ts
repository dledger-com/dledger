/**
 * Pure-JS Solana key derivation for browser-only mode.
 * Uses shared SLIP-0010 Ed25519 derivation.
 *
 * Derivation path: m/44'/501'/k'/0' (Phantom standard)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const SOL_COIN_TYPE = 501;

export interface DerivedSolAddress {
  index: number;
  address: string;
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
    const privateKey = slip0010DeriveKey(seed, SOL_COIN_TYPE, i);
    const publicKey = ed25519.getPublicKey(privateKey);
    results.push({ index: i, address: base58.encode(publicKey) });
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
