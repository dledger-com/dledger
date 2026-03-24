/**
 * Pure-JS Kaspa key derivation.
 * secp256k1 BIP-44, coin type 111111, path: m/44'/111111'/0'/0/N
 * Address: bech32("kaspa", schnorr_pubkey)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";

const KASPA_COIN_TYPE = 111111;

export interface DerivedKaspaAddress {
	index: number;
	address: string;
}

export interface KaspaInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

// ── Bech32 encoding (Kaspa uses standard bech32) ──────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
	const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
	let chk = 1;
	for (const v of values) {
		const top = chk >>> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ v;
		for (let i = 0; i < 5; i++) {
			if ((top >>> i) & 1) chk ^= GEN[i];
		}
	}
	return chk;
}

function bech32HrpExpand(hrp: string): number[] {
	const ret: number[] = [];
	for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >>> 5);
	ret.push(0);
	for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
	return ret;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
	const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
	const polymod = bech32Polymod(values) ^ 1;
	const ret: number[] = [];
	for (let i = 0; i < 6; i++) ret.push((polymod >>> (5 * (5 - i))) & 31);
	return ret;
}

function bech32Encode(hrp: string, data: number[]): string {
	const combined = data.concat(bech32CreateChecksum(hrp, data));
	return hrp + ":" + combined.map(d => BECH32_CHARSET[d]).join("");
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
	let acc = 0;
	let bits = 0;
	const ret: number[] = [];
	const maxv = (1 << toBits) - 1;

	for (const value of data) {
		acc = (acc << fromBits) | value;
		bits += fromBits;
		while (bits >= toBits) {
			bits -= toBits;
			ret.push((acc >>> bits) & maxv);
		}
	}

	if (pad) {
		if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
	}

	return ret;
}

function kaspaAddress(publicKey: Uint8Array): string {
	// Kaspa uses schnorr pubkey (x-only, 32 bytes) from compressed secp256k1
	// The x-coordinate is bytes [1:33] of the compressed pubkey
	const xOnly = publicKey.length === 33 ? publicKey.slice(1) : publicKey;

	// Prefix byte 0x00 for schnorr pubkey type, then the 32-byte x-only key
	const payload = new Uint8Array(1 + xOnly.length);
	payload[0] = 0x00; // ecdsa-schnorr pubkey type
	payload.set(xOnly, 1);

	const words = convertBits(payload, 8, 5, true);
	return bech32Encode("kaspa", words);
}

/**
 * Derive Kaspa addresses from a BIP-39 mnemonic.
 * Path: m/44'/111111'/0'/0/N (secp256k1 BIP-44)
 */
export function deriveKaspaAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedKaspaAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedKaspaAddress[] = [];

	const master = HDKey.fromMasterSeed(seed);
	const accountKey = master.derive(`m/44'/${KASPA_COIN_TYPE}'/0'/0`);

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(i);
		if (!child.publicKey) throw new Error("Failed to derive public key");
		results.push({ index: i, address: kaspaAddress(child.publicKey) });
	}

	return results;
}

export function detectKaspaInputType(input: string): KaspaInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Kaspa address: bech32 with kaspa: prefix
	if (/^kaspa:[a-z0-9]{61,63}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Kaspa Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
