import { describe, it, expect } from "vitest";
import { formatCurrency, formatDate, formatDateRelative } from "./format.js";

describe("formatCurrency", () => {
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
