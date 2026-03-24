/**
 * Pure-JS TRON key derivation.
 * secp256k1 BIP-44, path: m/44'/195'/0'/0/N
 * Address: keccak256(uncompressed_pubkey)[12:] -> add 0x41 prefix -> Base58Check
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { base58check as createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TronInputDetection } from "./types.js";

const base58check = createBase58check(sha256);

const TRON_COIN_TYPE = 195;

export interface DerivedTronAddress {
	index: number;
	address: string;
}

/** Encode a secp256k1 private key as a TRON T-address. */
function tronAddress(privateKey: Uint8Array): string {
	// Get uncompressed public key (65 bytes: 0x04 || x || y)
	const uncompressed = getPublicKey(privateKey, false) as Uint8Array;
	// keccak256 of the 64-byte public key (skip 0x04 prefix)
	const hash = keccak_256(uncompressed.slice(1));
	// Take last 20 bytes, prepend 0x41
	const payload = new Uint8Array(21);
	payload[0] = 0x41;
	payload.set(hash.slice(12), 1);
	return base58check.encode(payload);
}

/**
 * Derive multiple TRON addresses from a seed phrase.
 * Path: m/44'/195'/0'/0/N (BIP-44 standard)
 */
export function deriveTronAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedTronAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const master = HDKey.fromMasterSeed(seed);
	const start = startIndex ?? 0;
	const results: DerivedTronAddress[] = [];

	const accountKey = master.derive(`m/44'/${TRON_COIN_TYPE}'/0'/0`);

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(i);
		if (!child.privateKey) throw new Error(`Failed to derive child key at index ${i}`);
		results.push({ index: i, address: tronAddress(child.privateKey) });
	}

	return results;
}

/**
 * Validate a TRON T-address format.
 */
export function validateTronAddress(address: string): boolean {
	return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
}

/**
 * Detect the type of a TRON-related input.
 */
export function detectTronInputType(input: string): TronInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// TRON T-address
	if (validateTronAddress(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "TRON Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
