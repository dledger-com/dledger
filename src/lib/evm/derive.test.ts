import { describe, it, expect } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  detectEvmInputType,
  validateEvmSeedPhrase,
  deriveEvmAddress,
  deriveEvmAddressFromXpub,
  toChecksumAddress,
} from "./derive.js";

describe("detectEvmInputType", () => {
  it("detects a plain 0x address", () => {
    const r = detectEvmInputType("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(r.type).toBe("address");
    expect(r.isPrivate).toBe(false);
    expect(r.description).toBe("EVM Address");
  });

  it("detects a 64-char hex private key (no prefix)", () => {
    const r = detectEvmInputType("4c0883a69102937d6231471b5dbb6204fe512961708279f95e07be5dce06c1ab");
    expect(r.type).toBe("private_key");
    expect(r.isPrivate).toBe(true);
  });

  it("detects a 0x-prefixed 64-char hex private key", () => {
    const r = detectEvmInputType("0x4c0883a69102937d6231471b5dbb6204fe512961708279f95e07be5dce06c1ab");
    expect(r.type).toBe("private_key");
    expect(r.isPrivate).toBe(true);
  });

  it("detects a 12-word seed phrase", () => {
    const r = detectEvmInputType("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    expect(r.type).toBe("seed");
    expect(r.isPrivate).toBe(true);
    expect(r.description).toBe("Seed Phrase (12 words)");
  });

  it("detects a 24-word seed phrase", () => {
    const words = Array(23).fill("abandon").concat(["art"]);
    const r = detectEvmInputType(words.join(" "));
    expect(r.type).toBe("seed");
    expect(r.isPrivate).toBe(true);
    expect(r.description).toBe("Seed Phrase (24 words)");
  });

  it("returns unknown for empty input", () => {
    const r = detectEvmInputType("");
    expect(r.type).toBe("unknown");
    expect(r.isPrivate).toBe(false);
  });

  it("returns unknown for garbage", () => {
    const r = detectEvmInputType("not-a-valid-input!!!");
    expect(r.type).toBe("unknown");
    expect(r.isPrivate).toBe(false);
  });

  it("does not confuse an address with a private key", () => {
    // Address is 42 chars (0x + 40 hex), not 66 chars (0x + 64 hex)
    const r = detectEvmInputType("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(r.type).toBe("address");
  });

  it("detects an xpub", () => {
    // Derive a real xpub from the well-known mnemonic for a valid test value
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = mnemonicToSeedSync(mnemonic, "");
    const master = HDKey.fromMasterSeed(seed);
    const account = master.derive("m/44'/60'/0'");
    const xpub = account.publicExtendedKey;

    const r = detectEvmInputType(xpub);
    expect(r.type).toBe("xpub");
    expect(r.isPrivate).toBe(false);
    expect(r.description).toBe("Extended Public Key (xpub)");
  });
});

describe("validateEvmSeedPhrase", () => {
  it("validates a correct 12-word mnemonic", () => {
    const r = validateEvmSeedPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    expect(r.valid).toBe(true);
    expect(r.wordCount).toBe(12);
    expect(r.invalidWords).toEqual([]);
  });

  it("rejects invalid words", () => {
    const r = validateEvmSeedPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzz");
    expect(r.valid).toBe(false);
    expect(r.invalidWords).toContain("zzzzz");
  });

  it("rejects bad checksum", () => {
    // Valid words but wrong checksum
    const r = validateEvmSeedPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
    expect(r.valid).toBe(false);
    expect(r.invalidWords).toEqual([]);
  });

  it("reports word count", () => {
    const words = Array(15).fill("abandon");
    const r = validateEvmSeedPhrase(words.join(" "));
    expect(r.wordCount).toBe(15);
  });
});

describe("deriveEvmAddress", () => {
  it("derives correct address from well-known 12-word mnemonic", () => {
    // "abandon abandon ... about" → m/44'/60'/0'/0/0
    // Well-known test vector: 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const address = deriveEvmAddress(mnemonic);
    expect(address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("derives a different address with passphrase", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const addrNoPass = deriveEvmAddress(mnemonic);
    const addrWithPass = deriveEvmAddress(mnemonic, "mypassphrase");
    expect(addrWithPass).not.toBe(addrNoPass);
    // Should still be a valid checksummed address
    expect(addrWithPass).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("derives correct address from a known private key", () => {
    // Hardhat account 0
    const privKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const address = deriveEvmAddress(privKey);
    expect(address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("derives same address with or without 0x prefix", () => {
    const hex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const a1 = deriveEvmAddress(hex);
    const a2 = deriveEvmAddress("0x" + hex);
    expect(a1).toBe(a2);
  });

  it("throws on invalid input", () => {
    expect(() => deriveEvmAddress("not a valid input")).toThrow();
  });

  it("derives correct address from xpub (matches seed phrase derivation)", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = mnemonicToSeedSync(mnemonic, "");
    const master = HDKey.fromMasterSeed(seed);
    const account = master.derive("m/44'/60'/0'");
    const xpub = account.publicExtendedKey;

    const addrFromXpub = deriveEvmAddress(xpub);
    const addrFromSeed = deriveEvmAddress(mnemonic);
    expect(addrFromXpub).toBe(addrFromSeed);
  });

  it("derives correct address from xpub via deriveEvmAddressFromXpub", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = mnemonicToSeedSync(mnemonic, "");
    const master = HDKey.fromMasterSeed(seed);
    const account = master.derive("m/44'/60'/0'");
    const xpub = account.publicExtendedKey;

    const addr = deriveEvmAddressFromXpub(xpub);
    expect(addr).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("throws on invalid xpub (bad checksum)", () => {
    // Mangle the last few characters to break the base58check checksum
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed = mnemonicToSeedSync(mnemonic, "");
    const master = HDKey.fromMasterSeed(seed);
    const account = master.derive("m/44'/60'/0'");
    const xpub = account.publicExtendedKey;
    const badXpub = xpub.slice(0, -4) + "ZZZZ";

    expect(() => deriveEvmAddressFromXpub(badXpub)).toThrow();
  });
});

describe("toChecksumAddress", () => {
  it("checksums a known address correctly (EIP-55 test vectors)", () => {
    // From EIP-55 specification
    expect(toChecksumAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"))
      .toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"))
      .toBe("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
    expect(toChecksumAddress("0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb"))
      .toBe("0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB");
    expect(toChecksumAddress("0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb"))
      .toBe("0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb");
  });

  it("handles already-checksummed input", () => {
    const addr = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(toChecksumAddress(addr)).toBe(addr);
  });

  it("handles lowercase input", () => {
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"))
      .toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });
});
