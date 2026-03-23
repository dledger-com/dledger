/**
 * Pure-JS Aptos key derivation.
 * SLIP-0010 Ed25519, path: m/44'/637'/k'/0'
 * Address: sha3-256 of [ed25519_pubkey || 0x00]
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const APTOS_COIN_TYPE = 637;

export interface DerivedAptosAddress {
	index: number;
	address: string;
}

export interface AptosInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function aptosAddress(publicKey: Uint8Array): string {
	const payload = new Uint8Array(publicKey.length + 1);
	payload.set(publicKey, 0);
	payload[publicKey.length] = 0x00; // Ed25519 scheme flag APPENDED
	const hash = sha3_256(payload);
	return "0x" + Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function deriveAptosAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedAptosAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedAptosAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, APTOS_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: aptosAddress(publicKey) });
	}

	return results;
}

export function detectAptosInputType(input: string): AptosInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Aptos address (0x + 1-64 hex, normalize to 64)
	if (/^0x[a-fA-F0-9]{1,64}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Aptos Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
