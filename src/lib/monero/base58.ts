/**
 * Monero-variant Base58 encoding/decoding.
 * Unlike standard Base58Check, Monero splits the payload into 8-byte blocks,
 * each encoded to exactly 11 characters. The last block may be shorter.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP.set(ALPHABET[i], i);

const BLOCK_SIZE = 8; // bytes per block
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11]; // encoded chars for 1-8 byte blocks

/**
 * Encode a single block of up to 8 bytes into Base58 chars.
 * Left-pads with '1' (zero digit) to the expected length.
 */
function encodeBlock(block: Uint8Array): string {
	// Convert bytes to a BigInt
	let num = 0n;
	for (const byte of block) num = (num << 8n) | BigInt(byte);

	// Convert to base58
	const chars: string[] = [];
	while (num > 0n) {
		chars.push(ALPHABET[Number(num % 58n)]);
		num = num / 58n;
	}
	chars.reverse();

	// Pad to expected length
	const expectedLen = ENCODED_BLOCK_SIZES[block.length];
	while (chars.length < expectedLen) chars.unshift("1");

	return chars.join("");
}

/**
 * Decode a Base58-encoded block string back to bytes.
 */
function decodeBlock(encoded: string, blockByteLen: number): Uint8Array {
	let num = 0n;
	for (const ch of encoded) {
		const val = ALPHABET_MAP.get(ch);
		if (val === undefined) throw new Error(`Invalid Base58 character: ${ch}`);
		num = num * 58n + BigInt(val);
	}

	const result = new Uint8Array(blockByteLen);
	for (let i = blockByteLen - 1; i >= 0; i--) {
		result[i] = Number(num & 0xffn);
		num = num >> 8n;
	}
	return result;
}

/**
 * Encode a byte array using Monero's Base58 variant.
 * Splits into 8-byte blocks, each encoded to a fixed-width Base58 string.
 */
export function moneroBase58Encode(data: Uint8Array): string {
	const fullBlocks = Math.floor(data.length / BLOCK_SIZE);
	const lastBlockSize = data.length % BLOCK_SIZE;
	let result = "";

	for (let i = 0; i < fullBlocks; i++) {
		const block = data.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
		result += encodeBlock(block);
	}

	if (lastBlockSize > 0) {
		const lastBlock = data.subarray(fullBlocks * BLOCK_SIZE);
		result += encodeBlock(lastBlock);
	}

	return result;
}

/**
 * Decode a Monero Base58-encoded string back to bytes.
 */
export function moneroBase58Decode(encoded: string): Uint8Array {
	// Determine block structure from the encoded string length.
	// Each full 8-byte block → 11 chars.
	const fullBlockChars = 11;
	const fullBlocks = Math.floor(encoded.length / fullBlockChars);

	// Check if there's a remainder
	const remainderChars = encoded.length % fullBlockChars;
	let lastBlockBytes = 0;
	if (remainderChars > 0) {
		const idx = ENCODED_BLOCK_SIZES.indexOf(remainderChars);
		if (idx === -1) throw new Error(`Invalid Monero Base58 length: ${encoded.length}`);
		lastBlockBytes = idx;
	}

	const totalBytes = fullBlocks * BLOCK_SIZE + lastBlockBytes;
	const result = new Uint8Array(totalBytes);

	for (let i = 0; i < fullBlocks; i++) {
		const chunk = encoded.substring(i * fullBlockChars, (i + 1) * fullBlockChars);
		result.set(decodeBlock(chunk, BLOCK_SIZE), i * BLOCK_SIZE);
	}

	if (lastBlockBytes > 0) {
		const chunk = encoded.substring(fullBlocks * fullBlockChars);
		result.set(decodeBlock(chunk, lastBlockBytes), fullBlocks * BLOCK_SIZE);
	}

	return result;
}
