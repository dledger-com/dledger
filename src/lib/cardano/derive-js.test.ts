import { describe, it, expect } from "vitest";
import { deriveCardanoAddresses, detectCardanoInputType } from "./derive-js.js";

// Standard BIP-39 test mnemonic
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("deriveCardanoAddresses", () => {
	it("derives addresses from test mnemonic", () => {
		const results = deriveCardanoAddresses(TEST_MNEMONIC, 3);
		expect(results).toHaveLength(3);
		expect(results[0].index).toBe(0);
		expect(results[1].index).toBe(1);
		expect(results[2].index).toBe(2);
	});

	it("all derived addresses start with addr1", () => {
		const results = deriveCardanoAddresses(TEST_MNEMONIC, 3);
		for (const r of results) {
			expect(r.address).toMatch(/^addr1[0-9a-z]+$/);
		}
	});

	it("derives different addresses for different indices", () => {
		const results = deriveCardanoAddresses(TEST_MNEMONIC, 3);
		const addresses = results.map((r) => r.address);
		expect(new Set(addresses).size).toBe(3);
	});

	it("startIndex works correctly", () => {
		const first3 = deriveCardanoAddresses(TEST_MNEMONIC, 3);
		const from1 = deriveCardanoAddresses(TEST_MNEMONIC, 2, undefined, 1);
		expect(from1[0].address).toBe(first3[1].address);
		expect(from1[1].address).toBe(first3[2].address);
	});

	it("same mnemonic always produces same addresses", () => {
		const a = deriveCardanoAddresses(TEST_MNEMONIC, 1);
		const b = deriveCardanoAddresses(TEST_MNEMONIC, 1);
		expect(a[0].address).toBe(b[0].address);
	});

	it("passphrase changes derived addresses", () => {
		const without = deriveCardanoAddresses(TEST_MNEMONIC, 1);
		const with_ = deriveCardanoAddresses(TEST_MNEMONIC, 1, "mysecret");
		expect(without[0].address).not.toBe(with_[0].address);
	});
});

describe("detectCardanoInputType", () => {
	it("detects empty input", () => {
		const result = detectCardanoInputType("");
		expect(result.input_type).toBe("unknown");
		expect(result.valid).toBe(false);
	});

	it("detects a Cardano Shelley address", () => {
		// Generate a real address to test
		const addresses = deriveCardanoAddresses(TEST_MNEMONIC, 1);
		const result = detectCardanoInputType(addresses[0].address);
		expect(result.input_type).toBe("address");
		expect(result.valid).toBe(true);
		expect(result.is_private).toBe(false);
		expect(result.description).toBe("Cardano Address (Shelley)");
	});

	it("detects a BIP-39 seed phrase", () => {
		const result = detectCardanoInputType(TEST_MNEMONIC);
		expect(result.input_type).toBe("seed");
		expect(result.valid).toBe(true);
		expect(result.is_private).toBe(true);
		expect(result.word_count).toBe(12);
	});

	it("rejects invalid seed phrase", () => {
		const result = detectCardanoInputType("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
		expect(result.input_type).toBe("seed");
		expect(result.valid).toBe(false);
	});

	it("rejects random strings", () => {
		const result = detectCardanoInputType("not-an-address");
		expect(result.input_type).toBe("unknown");
	});
});
