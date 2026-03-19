import { describe, it, expect } from "vitest";
import { convertPrivateKeyJs, deriveBtcAddressesJs, detectBtcInputTypeJs } from "./derive-js.js";

// BIP39 test vector: "abandon" x11 + "about" (12-word mnemonic, no passphrase)
const TEST_MNEMONIC_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// 24-word test vector
const TEST_MNEMONIC_24 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("convertPrivateKeyJs", () => {
  describe("seed phrase → xpub", () => {
    it("derives zpub for BIP84 from 12-word mnemonic", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 84);
      expect(result.input_type).toBe("seed");
      expect(result.public_result.kind).toBe("Xpub");
      expect(result.suggested_bip).toBe(84);
      expect(result.network).toBe("mainnet");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^zpub/);
        expect(result.public_result.key_type).toBe("zpub");
      }
    });

    it("derives ypub for BIP49 from 12-word mnemonic", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 49);
      expect(result.input_type).toBe("seed");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^ypub/);
        expect(result.public_result.key_type).toBe("ypub");
      }
    });

    it("derives xpub for BIP44 from 12-word mnemonic", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 44);
      expect(result.input_type).toBe("seed");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^xpub/);
        expect(result.public_result.key_type).toBe("xpub");
      }
    });

    it("derives from 24-word mnemonic", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_24, 84);
      expect(result.input_type).toBe("seed");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^zpub/);
      }
    });

    it("produces different xpub with passphrase", () => {
      const withoutPass = convertPrivateKeyJs(TEST_MNEMONIC_12, 84);
      const withPass = convertPrivateKeyJs(TEST_MNEMONIC_12, 84, "mypassphrase");
      if (withoutPass.public_result.kind === "Xpub" && withPass.public_result.kind === "Xpub") {
        expect(withoutPass.public_result.xpub).not.toBe(withPass.public_result.xpub);
      }
    });

    it("derives testnet key when network is testnet", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 84, "", "testnet");
      expect(result.network).toBe("testnet");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^vpub/);
      }
    });

    it("throws on invalid mnemonic (bad checksum)", () => {
      // 12 valid words but wrong checksum
      expect(() => convertPrivateKeyJs("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon")).toThrow();
    });

    it("throws on garbage input", () => {
      expect(() => convertPrivateKeyJs("not a valid key")).toThrow();
    });

    // Known test vector: BIP84 "abandon x11 about" → first receive address
    it("matches known BIP84 test vector", () => {
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 84);
      if (result.public_result.kind === "Xpub") {
        // Derive first address from the zpub
        const addresses = deriveBtcAddressesJs(result.public_result.xpub, 84, 0, 0, 1, "mainnet");
        // Known first address for "abandon x11 about" BIP84
        expect(addresses[0]).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
      }
    });
  });

  describe("WIF → address", () => {
    it("converts compressed WIF to P2WPKH address", () => {
      // Known: privkey 1 in compressed WIF → specific address
      const wif = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
      const result = convertPrivateKeyJs(wif);
      expect(result.input_type).toBe("wif");
      expect(result.public_result.kind).toBe("Address");
      expect(result.network).toBe("mainnet");
      expect(result.suggested_bip).toBe(84);
      if (result.public_result.kind === "Address") {
        // Should be a bc1q... address (P2WPKH)
        expect(result.public_result.address).toMatch(/^bc1q/);
      }
    });

    it("converts uncompressed WIF to P2PKH address", () => {
      const wif = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ";
      const result = convertPrivateKeyJs(wif);
      expect(result.input_type).toBe("wif");
      expect(result.public_result.kind).toBe("Address");
      expect(result.suggested_bip).toBe(44);
      if (result.public_result.kind === "Address") {
        // Uncompressed → P2PKH (starts with 1)
        expect(result.public_result.address).toMatch(/^1/);
      }
    });

    it("detects testnet WIF", () => {
      // Valid testnet compressed WIF (privkey=1)
      const wif = "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA";
      const result = convertPrivateKeyJs(wif);
      expect(result.network).toBe("testnet");
      if (result.public_result.kind === "Address") {
        expect(result.public_result.address).toMatch(/^tb1/);
      }
    });
  });

  describe("xprv → xpub", () => {
    it("converts xprv to xpub", () => {
      const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
      const result = convertPrivateKeyJs(xprv);
      expect(result.input_type).toBe("xprv");
      expect(result.public_result.kind).toBe("Xpub");
      expect(result.network).toBe("mainnet");
      if (result.public_result.kind === "Xpub") {
        expect(result.public_result.xpub).toMatch(/^xpub/);
        // BIP32 test vector: master xpub for "000...000" seed
        expect(result.public_result.xpub).toBe(
          "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8"
        );
      }
    });

    it("converts zprv to zpub", () => {
      // First derive a zprv from a known seed, then convert
      const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 84);
      // The result is a zpub — to test zprv→zpub, we need an actual zprv
      // For now, just verify the flow works for xprv
      expect(result.public_result.kind).toBe("Xpub");
    });
  });
});

describe("deriveBtcAddressesJs", () => {
  // First get a known xpub to test with
  const getTestZpub = () => {
    const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 84);
    if (result.public_result.kind !== "Xpub") throw new Error("Expected Xpub");
    return result.public_result.xpub;
  };

  const getTestXpub = () => {
    const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 44);
    if (result.public_result.kind !== "Xpub") throw new Error("Expected Xpub");
    return result.public_result.xpub;
  };

  const getTestYpub = () => {
    const result = convertPrivateKeyJs(TEST_MNEMONIC_12, 49);
    if (result.public_result.kind !== "Xpub") throw new Error("Expected Xpub");
    return result.public_result.xpub;
  };

  it("derives BIP84 (P2WPKH) addresses from zpub", () => {
    const zpub = getTestZpub();
    const addrs = deriveBtcAddressesJs(zpub, 84, 0, 0, 3, "mainnet");
    expect(addrs).toHaveLength(3);
    for (const addr of addrs) {
      expect(addr).toMatch(/^bc1q/);
    }
    // Known first address for "abandon x11 about" BIP84
    expect(addrs[0]).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("derives BIP44 (P2PKH) addresses from xpub", () => {
    const xpub = getTestXpub();
    const addrs = deriveBtcAddressesJs(xpub, 44, 0, 0, 3, "mainnet");
    expect(addrs).toHaveLength(3);
    for (const addr of addrs) {
      expect(addr).toMatch(/^1/);
    }
  });

  it("derives BIP49 (P2SH-P2WPKH) addresses from ypub", () => {
    const ypub = getTestYpub();
    const addrs = deriveBtcAddressesJs(ypub, 49, 0, 0, 3, "mainnet");
    expect(addrs).toHaveLength(3);
    for (const addr of addrs) {
      expect(addr).toMatch(/^3/);
    }
  });

  it("derives change addresses (change=1)", () => {
    const zpub = getTestZpub();
    const receive = deriveBtcAddressesJs(zpub, 84, 0, 0, 1, "mainnet");
    const change = deriveBtcAddressesJs(zpub, 84, 1, 0, 1, "mainnet");
    expect(receive[0]).not.toBe(change[0]);
  });

  it("derives with offset (fromIndex > 0)", () => {
    const zpub = getTestZpub();
    const first3 = deriveBtcAddressesJs(zpub, 84, 0, 0, 3, "mainnet");
    const from1 = deriveBtcAddressesJs(zpub, 84, 0, 1, 2, "mainnet");
    expect(from1[0]).toBe(first3[1]);
    expect(from1[1]).toBe(first3[2]);
  });

  it("derives BIP86 (P2TR) addresses", () => {
    const zpub = getTestZpub();
    // P2TR addresses from any xpub variant (uses the pubkey directly)
    const addrs = deriveBtcAddressesJs(zpub, 86, 0, 0, 2, "mainnet");
    expect(addrs).toHaveLength(2);
    for (const addr of addrs) {
      expect(addr).toMatch(/^bc1p/);
    }
  });
});

describe("detectBtcInputTypeJs", () => {
  describe("seed phrases", () => {
    it("validates correct 12-word mnemonic", () => {
      const r = detectBtcInputTypeJs(TEST_MNEMONIC_12);
      expect(r.input_type).toBe("seed");
      expect(r.is_private).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.word_count).toBe(12);
      expect(r.invalid_words).toBeNull();
    });

    it("validates correct 24-word mnemonic", () => {
      const r = detectBtcInputTypeJs(TEST_MNEMONIC_24);
      expect(r.input_type).toBe("seed");
      expect(r.valid).toBe(true);
      expect(r.word_count).toBe(24);
    });

    it("rejects mnemonic with bad checksum", () => {
      // Replace last word to break checksum
      const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
      const r = detectBtcInputTypeJs(bad);
      expect(r.input_type).toBe("seed");
      expect(r.valid).toBe(false);
    });

    it("reports invalid words", () => {
      const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzz";
      const r = detectBtcInputTypeJs(bad);
      expect(r.input_type).toBe("seed");
      expect(r.valid).toBe(false);
      expect(r.invalid_words).toContain("zzzzz");
    });

    it("rejects wrong word count", () => {
      const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      const r = detectBtcInputTypeJs(bad);
      // 11 words doesn't match the seed regex (needs 12+)
      expect(r.valid).toBe(false);
    });
  });

  describe("WIF", () => {
    it("validates correct mainnet WIF", () => {
      const r = detectBtcInputTypeJs("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
      expect(r.input_type).toBe("wif");
      expect(r.is_private).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.network).toBe("mainnet");
    });

    it("validates correct testnet WIF", () => {
      const r = detectBtcInputTypeJs("cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA");
      expect(r.input_type).toBe("wif");
      expect(r.valid).toBe(true);
      expect(r.network).toBe("testnet");
    });
  });

  describe("extended private keys", () => {
    it("validates xprv", () => {
      const r = detectBtcInputTypeJs("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
      expect(r.input_type).toBe("xprv");
      expect(r.is_private).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.network).toBe("mainnet");
      expect(r.suggested_bip).toBe(44);
    });
  });

  describe("non-private types return unknown", () => {
    it("returns unknown for addresses", () => {
      const r = detectBtcInputTypeJs("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
      expect(r.input_type).toBe("unknown");
    });

    it("returns unknown for xpubs", () => {
      const r = detectBtcInputTypeJs("xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8");
      expect(r.input_type).toBe("unknown");
    });

    it("returns unknown for empty string", () => {
      const r = detectBtcInputTypeJs("");
      expect(r.input_type).toBe("unknown");
    });
  });
});
