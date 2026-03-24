/**
 * Pure-JS Algorand key derivation.
 * SLIP-0010 Ed25519, path: m/44'/283'/k'/0'
 * Address: Base32(ed25519_pubkey + checksum), checksum = sha512_256(pubkey)[28:32]
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512_256 } from "@noble/hashes/sha2.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const ALGORAND_COIN_TYPE = 283;

// RFC 4648 Base32 alphabet (no padding for Algorand)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface DerivedAlgorandAddress {
	index: number;
	address: string;
}

export interface AlgorandInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function base32Encode(data: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let result = "";

	for (const byte of data) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}

	return result;
}

function algorandAddress(publicKey: Uint8Array): string {
	// Checksum: last 4 bytes of SHA-512/256 of the public key
	const hash = sha512_256(publicKey);
	const checksum = hash.slice(28, 32);

	// Address = Base32(pubkey + checksum) = 58 chars
	const payload = new Uint8Array(publicKey.length + checksum.length);
	payload.set(publicKey);
	payload.set(checksum, publicKey.length);

	return base32Encode(payload);
}

/**
 * Derive Algorand addresses from a BIP-39 mnemonic.
 * Path: m/44'/283'/k'/0' (SLIP-0010 Ed25519)
 */
export function deriveAlgorandAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedAlgorandAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedAlgorandAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, ALGORAND_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: algorandAddress(publicKey) });
	}

	return results;
}

export function detectAlgorandInputType(input: string): AlgorandInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Algorand address: Base32, 58 chars, uppercase
	if (/^[A-Z2-7]{58}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Algorand Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
