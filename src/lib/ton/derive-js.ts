/**
 * Pure-JS TON key detection and address validation.
 * SLIP-0010 Ed25519, path: m/44'/607'/k'
 *
 * Note: TON address derivation from seed requires computing a wallet contract
 * StateInit hash, which needs TonWeb or equivalent. Without that dependency,
 * seed-based derivation returns empty — users should paste their actual address.
 */
import { validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

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
 * TON address derivation from seed is not supported without TonWeb.
 * The wallet contract StateInit hash is required to compute the address
 * from a public key, which is beyond what pure crypto primitives provide.
 * Users should paste their actual TON address instead.
 */
export function deriveTonAddresses(
	_mnemonic: string,
	_count: number,
	_passphrase?: string,
): DerivedTonAddress[] {
	return []; // Not supported without TonWeb
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
