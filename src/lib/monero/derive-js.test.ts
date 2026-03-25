import { describe, it, expect } from "vitest";
import { deriveMoneroAddresses, detectMoneroInputType, isValidViewKey } from "./derive-js.js";
import { moneroBase58Encode, moneroBase58Decode } from "./base58.js";

// Standard BIP-39 test mnemonic
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("moneroBase58", () => {
	it("encode/decode roundtrip for small data", () => {
		const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const encoded = moneroBase58Encode(data);
		const decoded = moneroBase58Decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("encode/decode roundtrip for 69-byte Monero address payload", () => {
		// Monero address = 1 network byte + 32 spend key + 32 view key + 4 checksum = 69 bytes
		const data = new Uint8Array(69);
		data[0] = 0x12; // mainnet
		for (let i = 1; i < 69; i++) data[i] = i % 256;
		const encoded = moneroBase58Encode(data);
		const decoded = moneroBase58Decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("produces 95-char string for 69-byte input", () => {
		const data = new Uint8Array(69);
		data[0] = 0x12;
		for (let i = 1; i < 69; i++) data[i] = 0xff;
		const encoded = moneroBase58Encode(data);
		// 69 bytes = 8 full blocks (8*8=64) + 5 remaining bytes
		// 8 * 11 + 7 = 95 chars
		expect(encoded.length).toBe(95);
	});

	it("encode/decode roundtrip for all zeros", () => {
		const data = new Uint8Array(69);
		const encoded = moneroBase58Encode(data);
		const decoded = moneroBase58Decode(encoded);
		expect(decoded).toEqual(data);
	});
});

describe("deriveMoneroAddresses", () => {
	it("derives addresses from test mnemonic", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 3);
		expect(results).toHaveLength(3);
		expect(results[0].index).toBe(0);
		expect(results[1].index).toBe(1);
		expect(results[2].index).toBe(2);
	});

	it("all derived addresses start with 4", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 3);
		for (const r of results) {
			expect(r.address).toMatch(/^4/);
		}
	});

	it("all derived addresses are 95 characters", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 3);
		for (const r of results) {
			expect(r.address.length).toBe(95);
		}
	});

	it("includes hex public keys", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		expect(results[0].publicSpendKey).toMatch(/^[0-9a-f]{64}$/);
		expect(results[0].publicViewKey).toMatch(/^[0-9a-f]{64}$/);
		expect(results[0].publicSpendKey).not.toBe(results[0].publicViewKey);
	});

	it("derives different addresses for different indices", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 3);
		const addresses = results.map((r) => r.address);
		expect(new Set(addresses).size).toBe(3);
	});

	it("startIndex works correctly", () => {
		const first3 = deriveMoneroAddresses(TEST_MNEMONIC, 3);
		const from1 = deriveMoneroAddresses(TEST_MNEMONIC, 2, undefined, 1);
		expect(from1[0].address).toBe(first3[1].address);
		expect(from1[1].address).toBe(first3[2].address);
	});

	it("same mnemonic always produces same addresses", () => {
		const a = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		const b = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		expect(a[0].address).toBe(b[0].address);
	});

	it("passphrase changes derived addresses", () => {
		const without = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		const with_ = deriveMoneroAddresses(TEST_MNEMONIC, 1, "mysecret");
		expect(without[0].address).not.toBe(with_[0].address);
	});

	it("derived address passes detectMoneroInputType", () => {
		const results = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		const detection = detectMoneroInputType(results[0].address);
		expect(detection.input_type).toBe("address");
		expect(detection.valid).toBe(true);
	});
});

describe("isValidViewKey", () => {
	it("accepts 64-char hex string", () => {
		expect(isValidViewKey("a".repeat(64))).toBe(true);
		expect(isValidViewKey("0123456789abcdef".repeat(4))).toBe(true);
	});

	it("rejects short hex", () => {
		expect(isValidViewKey("a".repeat(63))).toBe(false);
	});

	it("rejects non-hex characters", () => {
		expect(isValidViewKey("g".repeat(64))).toBe(false);
	});

	it("accepts uppercase hex", () => {
		expect(isValidViewKey("A".repeat(64))).toBe(true);
	});
});

describe("detectMoneroInputType", () => {
	it("detects empty input", () => {
		const result = detectMoneroInputType("");
		expect(result.input_type).toBe("unknown");
		expect(result.valid).toBe(false);
	});

	it("detects a derived Monero address", () => {
		const addresses = deriveMoneroAddresses(TEST_MNEMONIC, 1);
		const result = detectMoneroInputType(addresses[0].address);
		expect(result.input_type).toBe("address");
		expect(result.valid).toBe(true);
		expect(result.is_private).toBe(false);
		expect(result.description).toBe("Monero Address");
	});

	it("detects a BIP-39 seed phrase", () => {
		const result = detectMoneroInputType(TEST_MNEMONIC);
		expect(result.input_type).toBe("seed");
		expect(result.valid).toBe(true);
		expect(result.is_private).toBe(true);
		expect(result.word_count).toBe(12);
	});

	it("rejects random strings", () => {
		const result = detectMoneroInputType("not-an-address");
		expect(result.input_type).toBe("unknown");
	});
});
