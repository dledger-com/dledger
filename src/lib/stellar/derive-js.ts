/**
 * Pure-JS Stellar key derivation.
 * Ed25519 SLIP-0010, path: m/44'/148'/accountIndex' (only 3 levels)
 * Address: StrKey encoding (Base32 with 'G' prefix + CRC16)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { slip0010DeriveKey3 } from "../crypto/slip0010.js";
import type { StellarInputDetection } from "./types.js";

const STELLAR_COIN_TYPE = 148;

export interface DerivedStellarAddress {
	index: number;
	address: string;
}

/** CRC16-XMODEM used by Stellar StrKey encoding */
function crc16xmodem(data: Uint8Array): number {
	let crc = 0x0000;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i] << 8;
		for (let j = 0; j < 8; j++) {
			if (crc & 0x8000) {
				crc = (crc << 1) ^ 0x1021;
			} else {
				crc <<= 1;
			}
			crc &= 0xffff;
		}
	}
	return crc;
}

/** Base32 alphabet used by Stellar (RFC 4648, no padding) */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(data: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";

	for (let i = 0; i < data.length; i++) {
		value = (value << 8) | data[i];
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}

	return output;
}

function base32Decode(encoded: string): Uint8Array {
	const lookup = new Map<string, number>();
	for (let i = 0; i < BASE32_ALPHABET.length; i++) lookup.set(BASE32_ALPHABET[i], i);

	let bits = 0;
	let value = 0;
	const output: number[] = [];

	for (let i = 0; i < encoded.length; i++) {
		const v = lookup.get(encoded[i]);
		if (v === undefined) throw new Error(`Invalid base32 character: ${encoded[i]}`);
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			output.push((value >>> bits) & 0xff);
		}
	}

	return new Uint8Array(output);
}

/** Encode a 32-byte Ed25519 public key as a Stellar G-address (StrKey) */
function stellarAddress(publicKey: Uint8Array): string {
	// StrKey: version byte (0x30 = ED25519 public key => 'G' prefix) + 32-byte key + 2-byte CRC16
	const payload = new Uint8Array(35);
	payload[0] = 6 << 3; // version byte 0x30 for ED25519_PUBLIC_KEY
	payload.set(publicKey, 1);
	const crc = crc16xmodem(payload.subarray(0, 33));
	payload[33] = crc & 0xff; // little-endian
	payload[34] = (crc >>> 8) & 0xff;
	return base32Encode(payload);
}

/**
 * Derive multiple Stellar addresses from a seed phrase.
 * Path: m/44'/148'/accountIndex' (SLIP-0010, only 3 hardened levels)
 */
export function deriveStellarAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedStellarAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedStellarAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey3(seed, STELLAR_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: stellarAddress(publicKey) });
	}

	return results;
}

/**
 * Validate a Stellar G-address (StrKey format with checksum).
 */
export function validateStellarAddress(address: string): boolean {
	if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
	try {
		const decoded = base32Decode(address);
		if (decoded.length !== 35) return false;
		// Verify version byte
		if (decoded[0] !== (6 << 3)) return false;
		// Verify CRC16
		const expectedCrc = crc16xmodem(decoded.subarray(0, 33));
		const actualCrc = decoded[33] | (decoded[34] << 8);
		return expectedCrc === actualCrc;
	} catch {
		return false;
	}
}

/**
 * Detect the type of a Stellar-related input.
 */
export function detectStellarInputType(input: string): StellarInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Stellar G-address
	if (/^G[A-Z2-7]{55}$/.test(s)) {
		const valid = validateStellarAddress(s);
		return { input_type: "address", is_private: false, valid, word_count: null, description: "Stellar Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
