/**
 * Pure-JS TON key derivation and address computation.
 * SLIP-0010 Ed25519, path: m/44'/607'/k'
 * Address: wallet v4r2 StateInit hash → user-friendly Base64
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const TON_COIN_TYPE = 607;
const WALLET_ID = 698983191; // 0x29A9A317 (mainnet default)

// ── Wallet v4r2 code cell hash (precomputed) ───────────────
// The v4r2 contract code is a fixed BOC. Rather than embedding the full BOC
// and parsing it at runtime, we store the precomputed SHA-256 hash of the
// code cell's representation. This hash is constant across all v4r2 wallets.
// Source: https://github.com/ton-blockchain/wallet-contract-v4/
const V4R2_CODE_HASH = new Uint8Array([
	0xfe, 0xb5, 0xff, 0x68, 0x20, 0xe2, 0xff, 0x0d,
	0x94, 0x83, 0xe7, 0xe0, 0xd6, 0x2c, 0x81, 0x7d,
	0x84, 0x67, 0x89, 0xfb, 0x4a, 0xe5, 0x80, 0xc9,
	0x7e, 0x2d, 0xd6, 0x9d, 0x24, 0xf5, 0xbc, 0xbf,
]);
const V4R2_CODE_DEPTH = 0; // code cell has no refs, depth = 0

// ── Cell hash computation ───────────────────────────────────

/**
 * Compute SHA-256 hash of a cell's representation.
 * CellRepr = d1 || d2 || data_padded || ref_depths || ref_hashes
 */
function cellHash(
	bits: number,
	data: Uint8Array,
	refs: Array<{ hash: Uint8Array; depth: number }>,
): Uint8Array {
	const r = refs.length;
	const dataBytes = Math.ceil(bits / 8);

	// d1 = refs_count (for ordinary cells)
	const d1 = r;
	// d2 = floor(bits/8) + ceil(bits/8) (encodes bit length)
	const d2 = Math.floor(bits / 8) + Math.ceil(bits / 8);

	// Pad data with completion tag if bits not byte-aligned
	const padded = new Uint8Array(dataBytes);
	padded.set(data.subarray(0, dataBytes));
	if (bits % 8 !== 0) {
		// Set the completion bit: set bit at position (bits % 8) in last byte
		padded[dataBytes - 1] |= 1 << (7 - (bits % 8));
	}

	// Build repr: d1 + d2 + padded_data + ref_depths (2 bytes each) + ref_hashes (32 bytes each)
	const reprLen = 2 + dataBytes + r * 2 + r * 32;
	const repr = new Uint8Array(reprLen);
	repr[0] = d1;
	repr[1] = d2;
	repr.set(padded, 2);
	let offset = 2 + dataBytes;
	for (const ref of refs) {
		repr[offset] = (ref.depth >> 8) & 0xff;
		repr[offset + 1] = ref.depth & 0xff;
		offset += 2;
	}
	for (const ref of refs) {
		repr.set(ref.hash, offset);
		offset += 32;
	}

	return sha256(repr);
}

/**
 * Build the data cell for wallet v4r2:
 * 32 bits seqno (0) + 32 bits wallet_id + 256 bits pubkey + 1 bit empty hashmap = 321 bits
 */
function buildDataCell(publicKey: Uint8Array): { hash: Uint8Array; depth: number } {
	const bits = 321; // 32 + 32 + 256 + 1
	const dataBytes = Math.ceil(bits / 8); // 41 bytes
	const data = new Uint8Array(dataBytes);

	// seqno = 0 (first 4 bytes already zero)
	// wallet_id = 698983191 (0x29A9A317)
	data[4] = (WALLET_ID >>> 24) & 0xff;
	data[5] = (WALLET_ID >>> 16) & 0xff;
	data[6] = (WALLET_ID >>> 8) & 0xff;
	data[7] = WALLET_ID & 0xff;
	// public key (32 bytes at offset 8)
	data.set(publicKey, 8);
	// empty plugins hashmap = 0 bit (bit 320 = 0, already zero)

	return { hash: cellHash(bits, data, []), depth: 0 };
}

/**
 * Build StateInit cell and compute its hash (= the address).
 * StateInit: 5 bits (00110) + 2 refs (code, data)
 */
function stateInitHash(publicKey: Uint8Array): Uint8Array {
	const codeRef = { hash: V4R2_CODE_HASH, depth: V4R2_CODE_DEPTH };
	const dataRef = buildDataCell(publicKey);

	// StateInit data: 5 bits = 0b00110 = 0x30 >> 3... actually in binary: 00110
	// As a byte: 00110_000 = 0x30 (but we only use 5 bits)
	const stateInitData = new Uint8Array([0x30]); // only first 5 bits used
	return cellHash(5, stateInitData, [codeRef, dataRef]);
}

// ── CRC16-CCITT ─────────────────────────────────────────────

function crc16ccitt(data: Uint8Array): number {
	let crc = 0x0000;
	for (const byte of data) {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
			crc &= 0xffff;
		}
	}
	return crc;
}

// ── User-friendly address encoding ──────────────────────────

function toUserFriendlyAddress(hash: Uint8Array, workchain = 0, bounceable = true): string {
	const tag = bounceable ? 0x11 : 0x51;
	const buf = new Uint8Array(36);
	buf[0] = tag;
	buf[1] = workchain & 0xff;
	buf.set(hash, 2);
	const crc = crc16ccitt(buf.subarray(0, 34));
	buf[34] = (crc >> 8) & 0xff;
	buf[35] = crc & 0xff;

	// Base64url encoding
	let b64 = btoa(String.fromCharCode(...buf));
	b64 = b64.replace(/\+/g, "-").replace(/\//g, "_");
	return b64;
}

// ── Public API ──────────────────────────────────────────────

export interface DerivedTonAddress {
	index: number;
	address: string;
}

export interface TonInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

/**
 * Derive TON wallet v4r2 addresses from a BIP-39 seed phrase.
 * Path: m/44'/607'/accountIndex'
 */
export function deriveTonAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedTonAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedTonAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, TON_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		const addrHash = stateInitHash(publicKey);
		results.push({ index: i, address: toUserFriendlyAddress(addrHash) });
	}

	return results;
}

export function detectTonInputType(input: string): TonInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// User-friendly TON address (Base64, starts with EQ or UQ)
	if (/^[UE]Q[A-Za-z0-9_\-/+]{44,46}=?=?$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "TON Address" };
	}

	// Raw TON address (workchain:hex)
	if (/^-?[0-9]+:[0-9a-fA-F]{64}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "TON Address (raw)" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
