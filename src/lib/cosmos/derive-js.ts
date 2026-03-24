/**
 * Pure-JS Cosmos key derivation.
 * BIP-32 secp256k1, path: m/44'/118'/0'/0/N
 * Address: bech32("cosmos", ripemd160(sha256(compressed_secp256k1_pubkey)))
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bech32 } from "@scure/base";

export interface DerivedCosmosAddress {
	index: number;
	address: string;
}

export interface CosmosInputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

function cosmosAddress(compressedPubkey: Uint8Array): string {
	const hash = ripemd160(sha256(compressedPubkey));
	// bech32 encode: convert 8-bit bytes to 5-bit words
	const words = bech32.toWords(hash);
	return bech32.encode("cosmos", words);
}

export function deriveCosmosAddresses(
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedCosmosAddress[] {
	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const hd = HDKey.fromMasterSeed(seed);
	const start = startIndex ?? 0;
	const results: DerivedCosmosAddress[] = [];

	for (let i = start; i < start + count; i++) {
		const child = hd.derive(`m/44'/118'/0'/0/${i}`);
		const pubkey = child.publicKey!; // 33-byte compressed
		results.push({ index: i, address: cosmosAddress(pubkey) });
	}

	return results;
}

export function detectCosmosInputType(input: string): CosmosInputDetection {
	const s = input.trim();
	if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

	// Seed phrase
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return { input_type: "seed", is_private: true, valid: isValid, word_count: wordCount, description: `BIP39 Seed Phrase (${wordCount} words)` };
	}

	// Cosmos address (bech32, cosmos1 prefix)
	if (/^cosmos1[02-9ac-hj-np-z]{38}$/.test(s)) {
		return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Cosmos Address" };
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
