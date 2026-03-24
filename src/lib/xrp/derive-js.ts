/**
 * Pure-JS XRP key derivation.
 * secp256k1 BIP-44, path: m/44'/144'/0'/0/N
 * Address: Base58Check with version byte 0x00, using RIPEMD160(SHA256(compressed_pubkey))
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { base58check as createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import type { XrpInputDetection } from "./types.js";

const base58check = createBase58check(sha256);

const XRP_COIN_TYPE = 144;

export interface DerivedXrpAddress {
	index: number;
	address: string;
}

function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

/** Encode a compressed public key as an XRP r-address (Base58Check, version byte 0x00). */
function xrpAddress(publicKey: Uint8Array): string {
	const h = hash160(publicKey);
	const payload = new Uint8Array(21);
	payload[0] = 0x00; // version byte for XRP addresses
	payload.set(h, 1);
	return base58check.encode(payload);
}

/**
 * Derive multiple XRP addresses from a seed phrase.
 * Path: m/44'/144'/0'/0/N (BIP-44 standard)
 */
export function deriveXrpAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedXrpAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const master = HDKey.fromMasterSeed(seed);
	const start = startIndex ?? 0;
	const results: DerivedXrpAddress[] = [];

	const accountKey = master.derive(`m/44'/${XRP_COIN_TYPE}'/0'/0`);

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(i);
		if (!child.publicKey) throw new Error(`Failed to derive child key at index ${i}`);
		results.push({ index: i, address: xrpAddress(child.publicKey) });
	}

	return results;
}

/**
 * Validate an XRP r-address format.
 */
export function validateXrpAddress(address: string): boolean {
	return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

/**
 * Detect the type of an XRP-related input.
 */
export function detectXrpInputType(input: string): XrpInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// XRP r-address
	if (validateXrpAddress(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "XRP Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
