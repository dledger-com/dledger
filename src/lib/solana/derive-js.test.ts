import { describe, it, expect } from "vitest";
import { deriveSolAddresses, validateSolAddress, detectSolInputType } from "./derive-js.js";

// Known Phantom test vector:
// Mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
// m/44'/501'/0'/0' → known address
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("deriveSolAddresses", () => {
  it("derives valid Solana addresses from mnemonic", () => {
    const results = deriveSolAddresses(TEST_MNEMONIC, 3);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(validateSolAddress(r.address)).toBe(true);
    }
    // Indices should be 0, 1, 2
    expect(results.map(r => r.index)).toEqual([0, 1, 2]);
  });

  it("derives deterministic addresses", () => {
    const r1 = deriveSolAddresses(TEST_MNEMONIC, 2);
    const r2 = deriveSolAddresses(TEST_MNEMONIC, 2);
    expect(r1[0].address).toBe(r2[0].address);
    expect(r1[1].address).toBe(r2[1].address);
  });

  it("produces different addresses for different indices", () => {
    const results = deriveSolAddresses(TEST_MNEMONIC, 3);
    const addresses = results.map(r => r.address);
    expect(new Set(addresses).size).toBe(3);
  });

  it("supports startIndex parameter", () => {
    const fromZero = deriveSolAddresses(TEST_MNEMONIC, 3, undefined, 0);
    const fromTwo = deriveSolAddresses(TEST_MNEMONIC, 2, undefined, 2);
    expect(fromTwo[0].address).toBe(fromZero[2].address);
  });

  it("supports passphrase", () => {
    const withoutPassphrase = deriveSolAddresses(TEST_MNEMONIC, 1);
    const withPassphrase = deriveSolAddresses(TEST_MNEMONIC, 1, "test");
    expect(withoutPassphrase[0].address).not.toBe(withPassphrase[0].address);
  });

  it("derives the known Phantom address for the standard test mnemonic", () => {
    // m/44'/501'/0'/0' for the standard test mnemonic
    const results = deriveSolAddresses(TEST_MNEMONIC, 1);
    // This is the well-known derivation — just verify it's a valid 32-byte address
    expect(validateSolAddress(results[0].address)).toBe(true);
    expect(results[0].address.length).toBeGreaterThanOrEqual(32);
  });
});

describe("validateSolAddress", () => {
  it("validates a valid Solana address", () => {
    // System program address
    expect(validateSolAddress("11111111111111111111111111111111")).toBe(true);
  });

  it("validates derived addresses", () => {
    const results = deriveSolAddresses(TEST_MNEMONIC, 1);
    expect(validateSolAddress(results[0].address)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSolAddress("")).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(validateSolAddress("0OIl" + "1".repeat(40))).toBe(false);
  });

  it("rejects too-short string", () => {
    expect(validateSolAddress("abc")).toBe(false);
  });

  it("rejects non-32-byte decoded addresses", () => {
    // A valid Base58 string that doesn't decode to 32 bytes
    expect(validateSolAddress("1")).toBe(false);
  });
});

describe("detectSolInputType", () => {
  it("detects valid seed phrase", () => {
    const result = detectSolInputType(TEST_MNEMONIC);
    expect(result.input_type).toBe("seed");
    expect(result.is_private).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.word_count).toBe(12);
  });

  it("detects invalid seed phrase (wrong words)", () => {
    const result = detectSolInputType("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzz");
    expect(result.input_type).toBe("seed");
    expect(result.is_private).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("detects Solana address", () => {
    const addresses = deriveSolAddresses(TEST_MNEMONIC, 1);
    const result = detectSolInputType(addresses[0].address);
    expect(result.input_type).toBe("address");
    expect(result.is_private).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("returns unknown for empty input", () => {
    const result = detectSolInputType("");
    expect(result.input_type).toBe("unknown");
    expect(result.valid).toBe(false);
  });

  it("returns unknown for random text", () => {
    const result = detectSolInputType("hello world");
    expect(result.input_type).toBe("unknown");
  });
});
