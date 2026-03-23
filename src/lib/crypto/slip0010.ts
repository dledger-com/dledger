/**
 * Shared SLIP-0010 Ed25519 hardened key derivation.
 * Used by Solana (coin 501), Sui (coin 784), and Aptos (coin 637).
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

const ED25519_CURVE = "ed25519 seed";

function masterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
	const I = hmac(sha512, new TextEncoder().encode(ED25519_CURVE), seed);
	return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveChild(
	parentKey: Uint8Array,
	parentChainCode: Uint8Array,
	index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
	const hardenedIndex = index | 0x80000000;
	const data = new Uint8Array(37);
	data[0] = 0x00;
	data.set(parentKey, 1);
	data[33] = (hardenedIndex >>> 24) & 0xff;
	data[34] = (hardenedIndex >>> 16) & 0xff;
	data[35] = (hardenedIndex >>> 8) & 0xff;
	data[36] = hardenedIndex & 0xff;
	const I = hmac(sha512, parentChainCode, data);
	return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/**
 * Derive an Ed25519 private key from a BIP-39 seed using SLIP-0010 hardened path.
 * Path: m/44'/{coinType}'/accountIndex'/0'
 */
export function slip0010DeriveKey(seed: Uint8Array, coinType: number, accountIndex: number): Uint8Array {
	let { key, chainCode } = masterKey(seed);
	({ key, chainCode } = deriveChild(key, chainCode, 44));
	({ key, chainCode } = deriveChild(key, chainCode, coinType));
	({ key, chainCode } = deriveChild(key, chainCode, accountIndex));
	({ key } = deriveChild(key, chainCode, 0));
	return key;
}
