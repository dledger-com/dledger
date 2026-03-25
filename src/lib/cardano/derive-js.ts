/**
 * Pure-JS Cardano key derivation.
 * SLIP-0010 Ed25519, path: m/44'/1815'/k'/0'
 * Address: Bech32("addr", [header_byte] + Blake2b-224(pubkey) + Blake2b-224(staking_pubkey))
 *
 * Note: Cardano's official CIP-1852 uses a different derivation (Icarus/BIP32-Ed25519),
 * but hardware wallets (Ledger) use SLIP-0010 Ed25519 with coin type 1815.
 * We follow the SLIP-0010 approach for BIP-39 seed compatibility.
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32 } from "@scure/base";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const CARDANO_COIN_TYPE = 1815;

// Shelley enterprise address (type 6): no staking part, just payment credential
// Header byte: 0x61 = (0110 << 4) | 0001 (type 6 + mainnet)
const ENTERPRISE_HEADER_MAINNET = 0x61;

export interface DerivedCardanoAddress {
	index: number;
	address: string;
}

export interface CardanoInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

/**
 * Build a Shelley enterprise address (no staking key) from a payment public key.
 * Enterprise address = header_byte + Blake2b-224(payment_pubkey) = 29 bytes → Bech32
 */
function cardanoEnterpriseAddress(publicKey: Uint8Array): string {
	const keyHash = blake2b(publicKey, { dkLen: 28 }); // Blake2b-224
	const payload = new Uint8Array(1 + 28);
	payload[0] = ENTERPRISE_HEADER_MAINNET;
	payload.set(keyHash, 1);
	const words = bech32.toWords(payload);
	return bech32.encode("addr", words, 1023); // Cardano uses long bech32 (up to 1023 chars)
}

/**
 * Derive Cardano addresses from a BIP-39 mnemonic.
 * Path: m/44'/1815'/k'/0' (SLIP-0010 Ed25519)
 */
export function deriveCardanoAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedCardanoAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedCardanoAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const privateKey = slip0010DeriveKey(seed, CARDANO_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: cardanoEnterpriseAddress(publicKey) });
	}

	return results;
}

export function detectCardanoInputType(input: string): CardanoInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Cardano Shelley address: bech32 with addr1 prefix (addr_test1 for testnet)
	if (/^addr1[0-9a-z]{53,}$/.test(s) || /^addr_test1[0-9a-z]{50,}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Cardano Address (Shelley)" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
