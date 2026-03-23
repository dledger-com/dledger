/**
 * Pure-JS Tezos key derivation.
 * SLIP-0010 Ed25519, path: m/44'/1729'/k'/0'
 * Address: tz1 + Base58Check(Blake2b-160(ed25519_pubkey))
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const TEZOS_COIN_TYPE = 1729;

/** tz1 address prefix bytes */
const TZ1_PREFIX = new Uint8Array([0x06, 0xa1, 0x9f]);

export interface DerivedTezosAddress {
	index: number;
	address: string;
}

export interface TezosInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function base58check(payload: Uint8Array): string {
	const hash1 = sha256(payload);
	const hash2 = sha256(hash1);
	const checksum = hash2.slice(0, 4);
	const full = new Uint8Array(payload.length + 4);
	full.set(payload);
	full.set(checksum, payload.length);
	return base58.encode(full);
}

function tezosAddress(publicKey: Uint8Array): string {
	const pkHash = blake2b(publicKey, { dkLen: 20 });
	const payload = new Uint8Array(3 + 20);
	payload.set(TZ1_PREFIX, 0);
	payload.set(pkHash, 3);
	return base58check(payload);
}

export function deriveTezosAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedTezosAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedTezosAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, TEZOS_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: tezosAddress(publicKey) });
	}

	return results;
}

export function detectTezosInputType(input: string): TezosInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Tezos address (tz1/tz2/tz3/tz4 implicit accounts or KT1 originated accounts)
	if (/^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Tezos Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
