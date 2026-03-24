/**
 * Pure-JS Hedera key derivation and input detection.
 * Ed25519 SLIP-0010, coin type 3030.
 *
 * NOTE: Hedera addresses (0.0.X) are NOT derivable from keys alone —
 * an account must exist on the network. So deriveHederaAddresses() returns
 * an empty array (like original TON pattern). Only input detection is useful.
 */
import { validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

export interface DerivedHederaAddress {
	index: number;
	address: string;
}

export interface HederaInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

/**
 * Hedera addresses (0.0.X) cannot be derived from keys alone — they require
 * an on-chain account creation. This function returns an empty array.
 */
export function deriveHederaAddresses(
	_mnemonic: string,
	_count: number,
	_passphrase?: string,
	_startIndex?: number,
): DerivedHederaAddress[] {
	// Hedera account IDs (0.0.X) are assigned by the network upon account creation.
	// They cannot be derived from a seed phrase alone.
	return [];
}

export function detectHederaInputType(input: string): HederaInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Hedera address: 0.0.{number}
	if (/^0\.0\.\d+$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Hedera Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
