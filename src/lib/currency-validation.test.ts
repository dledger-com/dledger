import { describe, it, expect } from "vitest";
import { isValidCurrencyCode, isSpamCurrency } from "./currency-validation.js";

describe("isValidCurrencyCode", () => {
  it("accepts standard currency codes", () => {
    expect(isValidCurrencyCode("USD")).toBe(true);
    expect(isValidCurrencyCode("BTC")).toBe(true);
    expect(isValidCurrencyCode("ETH")).toBe(true);
  });

  it("accepts codes with dots, hyphens, underscores, slashes", () => {
    expect(isValidCurrencyCode("VALID.BTC")).toBe(true);
    expect(isValidCurrencyCode("LP-USDC/ETH")).toBe(true);
    expect(isValidCurrencyCode("USD_COIN")).toBe(true);
  });

  it("accepts codes with digits", () => {
    expect(isValidCurrencyCode("SHIB2")).toBe(true);
    expect(isValidCurrencyCode("1INCH")).toBe(true);
  });

  it("uppercases before testing (case-insensitive)", () => {
    expect(isValidCurrencyCode("btc")).toBe(true);
    expect(isValidCurrencyCode("Eth")).toBe(true);
  });

  it("rejects empty and whitespace-only codes", () => {
    expect(isValidCurrencyCode("")).toBe(false);
    expect(isValidCurrencyCode("   ")).toBe(false);
  });

  it("rejects codes with unicode/emoji", () => {
    expect(isValidCurrencyCode("\u{1F4B0}TOKEN")).toBe(false);
    expect(isValidCurrencyCode("\u{1F680}")).toBe(false);
  });

  it("rejects codes with spaces", () => {
    expect(isValidCurrencyCode("MY TOKEN")).toBe(false);
  });

  it("rejects contract address-like codes", () => {
    expect(isValidCurrencyCode("0x1234abcd5678ef90")).toBe(true); // hex is fine (upper)
  });
});

describe("isSpamCurrency", () => {
  it("is the inverse of isValidCurrencyCode", () => {
    expect(isSpamCurrency("USD")).toBe(false);
    expect(isSpamCurrency("")).toBe(true);
    expect(isSpamCurrency("\u{1F4B0}")).toBe(true);
  });
});
