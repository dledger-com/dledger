import { describe, it, expect, beforeEach } from "vitest";
import { formatCurrency, formatCurrencyFull, formatDate, formatDateRelative, setFormatLocale } from "./format.js";

describe("formatCurrency", () => {
  beforeEach(() => {
    setFormatLocale("en-US");
  });

  it("formats USD with symbol", () => {
    const result = formatCurrency("1000.50", "USD");
    expect(result).toContain("1,000.50");
    expect(result).toContain("$");
  });

  it("formats EUR with symbol", () => {
    const result = formatCurrency("1000", "EUR");
    // EUR formatter should include Euro symbol
    expect(result).toMatch(/€|EUR/);
  });

  it("handles non-ISO currency codes", () => {
    const result = formatCurrency("1.5", "BTC");
    // Non-ISO codes fall back to plain number + code
    expect(result).toContain("1.50");
    expect(result).toContain("BTC");
  });

  it("handles negative amounts", () => {
    const result = formatCurrency("-500", "USD");
    expect(result).toContain("500");
  });

  it("accepts numeric input", () => {
    const result = formatCurrency(42.5, "USD");
    expect(result).toContain("42.50");
  });

  it("formats with fr-FR locale", () => {
    setFormatLocale("fr-FR");
    const result = formatCurrency("1000", "EUR");
    expect(result).toContain("€");
    // French locale uses non-breaking space as thousands separator
    expect(result).toMatch(/1[\s\u00a0\u202f]000/);
  });

  it("formats with de-DE locale", () => {
    setFormatLocale("de-DE");
    const result = formatCurrency("1000.50", "EUR");
    expect(result).toContain("€");
    // German locale uses dot as thousands separator and comma as decimal
    expect(result).toMatch(/1\.000,50/);
  });

  it("expands precision for small crypto amounts", () => {
    const result = formatCurrency("0.001", "BTC");
    expect(result).toContain("0.001");
    expect(result).toContain("BTC");
  });

  it("expands precision for very small amounts", () => {
    const result = formatCurrency("0.00000123", "ETH");
    expect(result).toContain("ETH");
    // Should show enough digits to see non-zero value
    expect(result).not.toMatch(/^0\.0+ /);
  });

  it("does not expand precision for actual zero", () => {
    const result = formatCurrency("0", "BTC");
    expect(result).toContain("0.00");
    expect(result).toContain("BTC");
  });

  it("does not expand precision for normal amounts", () => {
    const result = formatCurrency("1.50", "BTC");
    expect(result).toContain("1.50");
    expect(result).toContain("BTC");
  });

  it("expands precision with fr-FR locale", () => {
    setFormatLocale("fr-FR");
    const result = formatCurrency("0.001", "BTC");
    expect(result).toContain("BTC");
    expect(result).toContain("0,001");
  });
});

describe("formatCurrencyFull", () => {
  beforeEach(() => {
    setFormatLocale("en-US");
  });

  it("preserves full precision for crypto amounts", () => {
    const result = formatCurrencyFull("1.23456789", "BTC");
    expect(result).toContain("1.23456789");
    expect(result).toContain("BTC");
  });

  it("keeps 2 decimals for round amounts", () => {
    const result = formatCurrencyFull("100.50", "BTC");
    expect(result).toContain("100.50");
    expect(result).toContain("BTC");
  });

  it("shows small decimal amounts", () => {
    const result = formatCurrencyFull("0.001", "ETH");
    expect(result).toContain("0.001");
    expect(result).toContain("ETH");
  });

  it("handles negative amounts", () => {
    const result = formatCurrencyFull("-5.12345", "BTC");
    expect(result).toContain("5.12345");
    expect(result).toContain("BTC");
  });

  it("appends code for non-ISO currencies", () => {
    const result = formatCurrencyFull("1.5", "AAPL");
    expect(result).toContain("1.50");
    expect(result).toContain("AAPL");
  });

  it("formats ISO currencies with symbol", () => {
    const result = formatCurrencyFull("1234.5678", "USD");
    expect(result).toContain("$");
    expect(result).toContain("1,234.5678");
  });

  it("accepts numeric input", () => {
    const result = formatCurrencyFull(42.123, "BTC");
    expect(result).toContain("42.123");
    expect(result).toContain("BTC");
  });

  it("strips trailing zeros beyond 2 decimals", () => {
    const result = formatCurrencyFull("1.50000000", "BTC");
    expect(result).toContain("1.50");
    expect(result).not.toContain("1.50000000");
  });

  it("handles integer amounts", () => {
    const result = formatCurrencyFull("100", "USD");
    expect(result).toContain("100.00");
  });
});

describe("formatDate", () => {
  it("formats YYYY-MM-DD (default)", () => {
    expect(formatDate("2024-01-15")).toBe("2024-01-15");
  });

  it("formats MM/DD/YYYY", () => {
    expect(formatDate("2024-01-15", "MM/DD/YYYY")).toBe("01/15/2024");
  });

  it("formats DD/MM/YYYY", () => {
    expect(formatDate("2024-01-15", "DD/MM/YYYY")).toBe("15/01/2024");
  });

  it("returns original string for invalid date", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDateRelative", () => {
  it("returns original for invalid date", () => {
    expect(formatDateRelative("nope")).toBe("nope");
  });
});
