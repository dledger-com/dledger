/**
 * Pure-JS Zcash key derivation (transparent addresses only).
 * secp256k1 BIP-44, coin type 133.
 * Address: Base58Check with version bytes 0x1CB8 (t1, P2PKH)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { base58 } from "@scure/base";

const ZCASH_COIN_TYPE = 133;
// Zcash transparent P2PKH version bytes: 0x1CB8
const ZCASH_P2PKH_VERSION = new Uint8Array([0x1c, 0xb8]);

export interface DerivedZcashAddress {
	index: number;
	address: string;
}

export interface ZcashInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

function base58check(payload: Uint8Array): string {
	const checksum = sha256(sha256(payload)).slice(0, 4);
	const full = new Uint8Array(payload.length + 4);
	full.set(payload);
	full.set(checksum, payload.length);
	return base58.encode(full);
}

function zcashAddress(publicKey: Uint8Array): string {
	const pubkeyHash = hash160(publicKey);

	// version (2 bytes) + pubkey hash (20 bytes)
	const payload = new Uint8Array(2 + pubkeyHash.length);
	payload.set(ZCASH_P2PKH_VERSION);
	payload.set(pubkeyHash, 2);

	return base58check(payload);
}

/**
 * Derive Zcash transparent addresses from a BIP-39 mnemonic.
 * Path: m/44'/133'/0'/0/N (secp256k1 BIP-44)
 */
export function deriveZcashAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedZcashAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedZcashAddress[] = [];

	const master = HDKey.fromMasterSeed(seed);
	const accountKey = master.derive(`m/44'/${ZCASH_COIN_TYPE}'/0'/0`);

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(i);
		if (!child.publicKey) throw new Error("Failed to derive public key");
		results.push({ index: i, address: zcashAddress(child.publicKey) });
	}

	return results;
}

export function detectZcashInputType(input: string): ZcashInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Zcash transparent address: t1... (P2PKH) or t3... (P2SH)
	if (/^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Zcash Transparent Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
