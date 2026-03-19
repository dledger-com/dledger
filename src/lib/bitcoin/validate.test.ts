import { describe, it, expect } from "vitest";
import { detectInputType } from "./validate.js";

describe("detectInputType", () => {
  describe("addresses", () => {
    it("detects P2PKH address", () => {
      const r = detectInputType("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
      expect(r.type).toBe("address");
      expect(r.isPrivate).toBe(false);
      expect(r.description).toBe("Bitcoin Address");
    });

    it("detects P2SH address", () => {
      const r = detectInputType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
      expect(r.type).toBe("address");
      expect(r.isPrivate).toBe(false);
    });

    it("detects bech32 address", () => {
      const r = detectInputType("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
      expect(r.type).toBe("address");
      expect(r.isPrivate).toBe(false);
    });

    it("detects taproot address", () => {
      const r = detectInputType("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297");
      expect(r.type).toBe("address");
      expect(r.isPrivate).toBe(false);
    });

    it("detects testnet address", () => {
      const r = detectInputType("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
      expect(r.type).toBe("address");
      expect(r.isPrivate).toBe(false);
    });
  });

  describe("extended public keys", () => {
    it("detects xpub", () => {
      const r = detectInputType("xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8");
      expect(r.type).toBe("xpub");
      expect(r.isPrivate).toBe(false);
      expect(r.description).toContain("Extended Public Key");
    });

    it("detects ypub", () => {
      // ypub is same length, starts with ypub
      const r = detectInputType("ypub6Ww3ibDFAga2EHfWj9sT5HUGQVfYVXHqiSiDBEPDpoL7p6bG7MBuLFq9Xnwkic1WVLxqtaoGitLTdZ5SmuiPcPWDn5MZRDqKcZG3QCjDKK2");
      expect(r.type).toBe("xpub");
      expect(r.isPrivate).toBe(false);
      expect(r.description).toContain("BIP49");
    });

    it("detects zpub", () => {
      const r = detectInputType("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtympa9S76jRhiKL599PVyBww6SeSTTiMLz3J9FdBb5nM7NDAkNiDGKFyQ3TQg9MaF3pZM9tGLCqjbqq");
      expect(r.type).toBe("xpub");
      expect(r.isPrivate).toBe(false);
      expect(r.description).toContain("BIP84");
    });
  });

  describe("WIF private keys", () => {
    it("detects compressed WIF (K prefix)", () => {
      const r = detectInputType("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
      expect(r.type).toBe("wif");
      expect(r.isPrivate).toBe(true);
      expect(r.description).toBe("WIF Private Key");
    });

    it("detects compressed WIF (L prefix)", () => {
      const r = detectInputType("L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ");
      expect(r.type).toBe("wif");
      expect(r.isPrivate).toBe(true);
    });

    it("detects uncompressed WIF (5 prefix)", () => {
      const r = detectInputType("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ");
      expect(r.type).toBe("wif");
      expect(r.isPrivate).toBe(true);
    });
  });

  describe("extended private keys", () => {
    it("detects xprv", () => {
      const r = detectInputType("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
      expect(r.type).toBe("xprv");
      expect(r.isPrivate).toBe(true);
      expect(r.description).toContain("Extended Private Key");
    });

    it("detects zprv", () => {
      const r = detectInputType("zprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
      // Note: same data but z prefix — regex matches structurally
      expect(r.type).toBe("xprv");
      expect(r.isPrivate).toBe(true);
    });
  });

  describe("seed phrases", () => {
    it("detects 12-word seed phrase", () => {
      const r = detectInputType("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
      expect(r.type).toBe("seed");
      expect(r.isPrivate).toBe(true);
      expect(r.description).toContain("12 words");
    });

    it("detects 24-word seed phrase", () => {
      const words = "abandon ".repeat(23) + "art";
      const r = detectInputType(words);
      expect(r.type).toBe("seed");
      expect(r.isPrivate).toBe(true);
      expect(r.description).toContain("24 words");
    });

    it("does not match short word lists", () => {
      const r = detectInputType("hello world foo bar");
      expect(r.type).toBe("unknown");
    });
  });

  describe("edge cases", () => {
    it("returns unknown for empty input", () => {
      const r = detectInputType("");
      expect(r.type).toBe("unknown");
      expect(r.isPrivate).toBe(false);
    });

    it("returns unknown for garbage input", () => {
      const r = detectInputType("not-a-bitcoin-thing-at-all!!!");
      expect(r.type).toBe("unknown");
    });

    it("handles whitespace-padded input", () => {
      const r = detectInputType("  bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq  ");
      expect(r.type).toBe("address");
    });

    it("isPrivate is false for all public types", () => {
      expect(detectInputType("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").isPrivate).toBe(false);
      expect(detectInputType("xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8").isPrivate).toBe(false);
    });

    it("isPrivate is true for all private types", () => {
      expect(detectInputType("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn").isPrivate).toBe(true);
      expect(detectInputType("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi").isPrivate).toBe(true);
      expect(detectInputType("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").isPrivate).toBe(true);
    });
  });
});
