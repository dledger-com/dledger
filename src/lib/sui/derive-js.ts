/**
 * Pure-JS Sui key derivation.
 * SLIP-0010 Ed25519, path: m/44'/784'/k'/0'
 * Address: blake2b-256 of [0x00 || ed25519_pubkey]
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const SUI_COIN_TYPE = 784;

export interface DerivedSuiAddress {
	index: number;
	address: string;
}

export interface SuiInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function suiAddress(publicKey: Uint8Array): string {
	const payload = new Uint8Array(1 + publicKey.length);
	payload[0] = 0x00; // Ed25519 scheme flag
	payload.set(publicKey, 1);
	const hash = blake2b(payload, { dkLen: 32 });
	return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function deriveSuiAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedSuiAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedSuiAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, SUI_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: suiAddress(publicKey) });
	}

	return results;
}

export function detectSuiInputType(input: string): SuiInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Sui address (0x + 64 hex)
	if (/^0x[a-fA-F0-9]{64}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Sui Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
