/**
 * Pure-JS Stacks key derivation.
 * secp256k1 BIP-44, coin type 5757.
 * Address: Crockford Base32 encoding (different from standard Base32).
 * Stacks addresses start with "SP" (mainnet single-sig).
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const STACKS_COIN_TYPE = 5757;
const STACKS_MAINNET_SINGLE_SIG = 22; // version byte for SP addresses

// Crockford Base32 alphabet (used by Stacks, NOT RFC 4648)
const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface DerivedStacksAddress {
	index: number;
	address: string;
}

export interface StacksInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

/**
 * Encode bytes to Crockford Base32 (c32).
 */
function c32Encode(data: Uint8Array): string {
	let result = "";
	let buffer = 0;
	let bits = 0;

	for (const byte of data) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += C32_ALPHABET[(buffer >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		result += C32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
	}

	return result;
}

/**
 * c32check encoding: version + hash160, with a double-SHA256 checksum.
 */
function c32checkEncode(version: number, data: Uint8Array): string {
	// Checksum: first 4 bytes of SHA256(SHA256(version + data))
	const versionedData = new Uint8Array(1 + data.length);
	versionedData[0] = version;
	versionedData.set(data, 1);

	const checksum = sha256(sha256(versionedData)).slice(0, 4);

	// c32 encode: data + checksum (version is encoded as prefix character)
	const payload = new Uint8Array(data.length + 4);
	payload.set(data);
	payload.set(checksum, data.length);

	const c32 = c32Encode(payload);
	const versionChar = C32_ALPHABET[version];
	return `S${versionChar}${c32}`;
}

function stacksAddress(publicKey: Uint8Array): string {
	const pubkeyHash = hash160(publicKey);
	return c32checkEncode(STACKS_MAINNET_SINGLE_SIG, pubkeyHash);
}

/**
 * Derive Stacks addresses from a BIP-39 mnemonic.
 * Path: m/44'/5757'/0'/0/N (secp256k1 BIP-44)
 */
export function deriveStacksAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedStacksAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedStacksAddress[] = [];

	const master = HDKey.fromMasterSeed(seed);
	const accountKey = master.derive(`m/44'/${STACKS_COIN_TYPE}'/0'/0`);

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(i);
		if (!child.publicKey) throw new Error("Failed to derive public key");
		results.push({ index: i, address: stacksAddress(child.publicKey) });
	}

	return results;
}

export function detectStacksInputType(input: string): StacksInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Stacks address: starts with SP, followed by Crockford Base32 characters
	if (/^SP[0-9A-Z]{28,38}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Stacks Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
