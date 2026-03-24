/**
 * Pure-JS BIP-44 secp256k1 derivation for BTC-fork chains.
 * Parameterized by coin type and address encoding (version byte).
 *
 * - DOGE: P2PKH with version byte 0x1E
 * - LTC:  P2PKH with version byte 0x30, P2SH with 0x32
 * - BCH:  CashAddr (detect only — not derived from seed for now)
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { base58check as createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import type { BtcForkChainConfig, BtcForkInputDetection, DerivedBtcForkAddress } from "./types.js";

const base58check = createBase58check(sha256);

// ── Version bytes for P2PKH encoding ─────────────────────

const P2PKH_VERSION: Record<string, number> = {
	doge: 0x1e,
	ltc: 0x30,
};

// ── Helpers ──────────────────────────────────────────────

function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

function encodeP2PKH(pubkey: Uint8Array, versionByte: number): string {
	const h = hash160(pubkey);
	const payload = new Uint8Array(21);
	payload[0] = versionByte;
	payload.set(h, 1);
	return base58check.encode(payload);
}

// ── Public API ───────────────────────────────────────────

/**
 * Derive BIP-44 addresses for a BTC-fork chain from a mnemonic seed phrase.
 * Path: m/44'/{coinType}'/0'/0/{index}
 *
 * For DOGE and LTC, produces P2PKH addresses with the chain's version byte.
 * BCH is not supported for derivation (CashAddr encoding is non-trivial).
 */
export function deriveBtcForkAddresses(
	config: BtcForkChainConfig,
	mnemonic: string,
	count: number,
	passphrase?: string,
	startIndex?: number,
): DerivedBtcForkAddress[] {
	if (config.id === "bch") {
		throw new Error("BCH address derivation from seed is not yet supported (CashAddr encoding).");
	}

	const versionByte = P2PKH_VERSION[config.id];
	if (versionByte === undefined) {
		throw new Error(`No P2PKH version byte defined for chain: ${config.id}`);
	}

	const seed = mnemonicToSeedSync(mnemonic, passphrase ?? "");
	const master = HDKey.fromMasterSeed(seed);
	const start = startIndex ?? 0;
	const results: DerivedBtcForkAddress[] = [];

	// BIP-44 path: m/44'/{coinType}'/0'/0/{index}
	const accountPath = `m/44'/${config.coinType}'/0'`;
	const accountKey = master.derive(accountPath);

	if (!accountKey.publicKey || !accountKey.chainCode) {
		throw new Error("Failed to derive account key");
	}

	for (let i = start; i < start + count; i++) {
		const child = accountKey.deriveChild(0).deriveChild(i);
		const pubkey = child.publicKey;
		if (!pubkey) throw new Error(`Failed to derive child key at index ${i}`);
		const address = encodeP2PKH(pubkey, versionByte);
		results.push({ index: i, address });
	}

	return results;
}

/**
 * Detect the type of user input for a BTC-fork chain.
 * Returns whether the input looks like an address or a seed phrase.
 */
export function detectBtcForkInputType(
	config: BtcForkChainConfig,
	input: string,
): BtcForkInputDetection {
	const s = input.trim();
	if (!s) {
		return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
	}

	// Seed phrase detection
	const words = s.split(/\s+/);
	if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
		const wordCount = words.length;
		const isValid = [12, 15, 18, 21, 24].includes(wordCount) && validateMnemonic(s, english);
		return {
			input_type: "seed",
			is_private: true,
			valid: isValid,
			word_count: wordCount,
			description: `BIP39 Seed Phrase (${wordCount} words)`,
		};
	}

	// Address detection using chain-specific regex
	if (config.addressRegex.test(s)) {
		return {
			input_type: "address",
			is_private: false,
			valid: true,
			word_count: null,
			description: `${config.name} Address`,
		};
	}

	return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
