/**
 * Pure-JS NEAR key derivation.
 * SLIP-0010 Ed25519, path: m/44'/397'/k'/0'
 * Address: hex(ed25519_pubkey) — implicit account ID
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const NEAR_COIN_TYPE = 397;

export interface DerivedNearAddress {
	index: number;
	address: string;
}

export interface NearInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive NEAR implicit account addresses from a BIP-39 mnemonic.
 * Path: m/44'/397'/k'/0' (SLIP-0010 Ed25519)
 * Address: hex-encoded ed25519 public key (64 chars)
 */
export function deriveNearAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedNearAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedNearAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, NEAR_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: bytesToHex(publicKey) });
	}

	return results;
}

export function detectNearInputType(input: string): NearInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Named NEAR address (alice.near)
	if (/^[a-z0-9._-]+\.near$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "NEAR Named Address" };
	}

	// Implicit NEAR address (64-char hex)
	if (/^[0-9a-f]{64}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "NEAR Implicit Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
