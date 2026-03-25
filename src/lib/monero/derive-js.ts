/**
 * Pure-JS Monero key derivation.
 * BIP-44 path: m/44'/128'/k'/0' via SLIP-0010 Ed25519
 *
 * Key derivation:
 *   - Private spend key = SLIP-0010 derived key
 *   - Private view key  = Keccak-256(spend_key) reduced mod ed25519 curve order l
 *   - Public keys       = ed25519.getPublicKey(private_key)
 *   - Address           = MoneroBase58(network_byte + public_spend_key + public_view_key + checksum)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";
import { moneroBase58Encode } from "./base58.js";

const MONERO_COIN_TYPE = 128;
const MAINNET_NETWORK_BYTE = 0x12; // 18 decimal

// Ed25519 curve order l = 2^252 + 27742317777372353535851937790883648493
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

export interface DerivedMoneroAddress {
	index: number;
	address: string;
	publicSpendKey: string; // hex
	publicViewKey: string; // hex
}

export interface MoneroInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

/**
 * Reduce a 32-byte scalar modulo the ed25519 curve order l.
 * This is how Monero derives the private view key from the spend key.
 */
function scReduce32(bytes: Uint8Array): Uint8Array {
	// Read as little-endian 256-bit integer
	let n = 0n;
	for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);

	// Reduce mod l
	n = n % L;

	// Write back as little-endian
	const result = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		result[i] = Number(n & 0xffn);
		n >>= 8n;
	}
	return result;
}

/**
 * Derive the private view key from a private spend key.
 * view_key = Keccak-256(spend_key) mod l
 */
function deriveViewKey(spendKey: Uint8Array): Uint8Array {
	const hash = keccak_256(spendKey);
	return scReduce32(hash);
}

/**
 * Build a Monero standard address from public spend and view keys.
 * Format: network_byte(1) + public_spend_key(32) + public_view_key(32) + checksum(4)
 * Checksum = first 4 bytes of Keccak-256(prefix)
 */
function moneroAddress(publicSpendKey: Uint8Array, publicViewKey: Uint8Array, networkByte: number = MAINNET_NETWORK_BYTE): string {
	const prefix = new Uint8Array(1 + 32 + 32);
	prefix[0] = networkByte;
	prefix.set(publicSpendKey, 1);
	prefix.set(publicViewKey, 33);

	const checksum = keccak_256(prefix).slice(0, 4);

	const full = new Uint8Array(prefix.length + 4);
	full.set(prefix);
	full.set(checksum, prefix.length);

	return moneroBase58Encode(full);
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive Monero addresses from a BIP-39 mnemonic.
 * Path: m/44'/128'/k'/0' (SLIP-0010 Ed25519)
 */
export function deriveMoneroAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedMoneroAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedMoneroAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const spendKey = slip0010DeriveKey(seed, MONERO_COIN_TYPE, i);
		const viewKey = deriveViewKey(spendKey);
		const publicSpendKey = ed25519.getPublicKey(spendKey);
		const publicViewKey = ed25519.getPublicKey(viewKey);
		results.push({
			index: i,
			address: moneroAddress(publicSpendKey, publicViewKey),
			publicSpendKey: bytesToHex(publicSpendKey),
			publicViewKey: bytesToHex(publicViewKey),
		});
	}

	return results;
}

/**
 * Validate a hex view key: 64 hex characters.
 */
export function isValidViewKey(key: string): boolean {
	return /^[0-9a-fA-F]{64}$/.test(key.trim());
}

export function detectMoneroInputType(input: string): MoneroInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Monero standard address: starts with 4, 95 chars, Base58 alphabet
	if (/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Monero Address" };
	}

	// Monero subaddress: starts with 8, 95 chars
	if (/^8[1-9A-HJ-NP-Za-km-z]{94}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Monero Subaddress" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
