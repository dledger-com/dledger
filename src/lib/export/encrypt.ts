// AES-256-GCM encryption/decryption with PBKDF2 key derivation.
// Uses Web Crypto API — no external dependencies.

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for SHA-256

function uint8ToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function base64ToUint8(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export interface EncryptResult {
	saltBase64: string;
	ivBase64: string;
	ciphertext: Uint8Array;
}

/**
 * Encrypt data with AES-256-GCM using a passphrase-derived key.
 */
export async function encrypt(plaintext: Uint8Array, passphrase: string): Promise<EncryptResult> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
	);

	return {
		saltBase64: uint8ToBase64(salt),
		ivBase64: uint8ToBase64(iv),
		ciphertext,
	};
}

/**
 * Decrypt AES-256-GCM ciphertext with a passphrase-derived key.
 * Throws DOMException if passphrase is wrong (GCM auth tag mismatch).
 */
export async function decrypt(
	ciphertext: Uint8Array,
	passphrase: string,
	saltBase64: string,
	ivBase64: string,
): Promise<Uint8Array> {
	const salt = base64ToUint8(saltBase64);
	const iv = base64ToUint8(ivBase64);
	const key = await deriveKey(passphrase, salt);

	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
	return new Uint8Array(plaintext);
}
