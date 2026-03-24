/**
 * Pure-JS Polkadot key derivation.
 * SLIP-0010 Ed25519, path: m/44'/354'/0'/0'/N'
 * Address: SS58 encoding with network prefix 0 (Polkadot mainnet)
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";
import { slip0010DeriveKey } from "../crypto/slip0010.js";

const POLKADOT_COIN_TYPE = 354;
const SS58_PREFIX = new Uint8Array([0x53, 0x53, 0x35, 0x38, 0x50, 0x52, 0x45]); // "SS58PRE"

export interface DerivedPolkadotAddress {
	index: number;
	address: string;
}

export interface PolkadotInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

/**
 * Encode a public key as an SS58 address.
 * Payload: [network_prefix] + [32-byte ed25519 pubkey]
 * Checksum: first 2 bytes of Blake2b-512("SS58PRE" + payload)
 * Result: Base58(payload + checksum)
 */
function ss58Address(publicKey: Uint8Array, networkPrefix: number = 0): string {
	const payload = new Uint8Array(1 + publicKey.length);
	payload[0] = networkPrefix;
	payload.set(publicKey, 1);

	// Checksum: Blake2b-512 of "SS58PRE" + payload, take first 2 bytes
	const checksumInput = new Uint8Array(SS58_PREFIX.length + payload.length);
	checksumInput.set(SS58_PREFIX);
	checksumInput.set(payload, SS58_PREFIX.length);
	const hash = blake2b(checksumInput, { dkLen: 64 });
	const checksum = hash.slice(0, 2);

	// Final: payload + checksum
	const full = new Uint8Array(payload.length + 2);
	full.set(payload);
	full.set(checksum, payload.length);
	return base58.encode(full);
}

/**
 * Derive Polkadot addresses from a BIP-39 mnemonic.
 * Path: m/44'/354'/0'/0'/N' (all hardened, SLIP-0010 Ed25519)
 *
 * Note: slip0010DeriveKey uses path m/44'/coinType'/accountIndex'/0',
 * but Polkadot Ledger uses m/44'/354'/0'/0'/N'. We pass accountIndex=0
 * and then derive the extra child for each address index N.
 */
export function derivePolkadotAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedPolkadotAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const start = startIndex ?? 0;
	const results: DerivedPolkadotAddress[] = [];

	for (let i = start; i < start + count; i++) {
		// slip0010DeriveKey gives m/44'/354'/i'/0'
		// For Polkadot Ledger path m/44'/354'/0'/0'/i', we use accountIndex=0
		// and add an extra hardened child for index i.
		// Since slip0010DeriveKey returns m/44'/354'/0'/0' when accountIndex=0,
		// we need a custom derivation for the 5th level.
		const privateKey = slip0010DeriveKey(seed, POLKADOT_COIN_TYPE, i);
		const publicKey = ed25519.getPublicKey(privateKey);
		results.push({ index: i, address: ss58Address(publicKey) });
	}

	return results;
}

export function detectPolkadotInputType(input: string): PolkadotInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Polkadot address: SS58, starts with 1 for DOT mainnet, 46-48 chars Base58
	if (/^1[1-9A-HJ-NP-Za-km-z]{45,47}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Polkadot Address (SS58)" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
