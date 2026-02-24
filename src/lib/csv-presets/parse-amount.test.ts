import { describe, it, expect } from "vitest";
import { parseAmount, detectNumberFormat } from "./parse-amount.js";

describe("parseAmount", () => {
  it("parses simple numbers", () => {
    expect(parseAmount("100")).toBe(100);
    expect(parseAmount("100.50")).toBe(100.5);
    expect(parseAmount("-50.25")).toBe(-50.25);
  });

  it("handles currency symbols", () => {
    expect(parseAmount("$100.00")).toBe(100);
    expect(parseAmount("€50.00")).toBe(50);
    expect(parseAmount("£75.50")).toBe(75.5);
  });

  it("handles currency code prefix", () => {
    expect(parseAmount("EUR 100")).toBe(100);
    expect(parseAmount("USD 1234.56")).toBe(1234.56);
  });

  it("handles parentheses for negatives", () => {
    expect(parseAmount("(100.00)")).toBe(-100);
    expect(parseAmount("(50)")).toBe(-50);
    expect(parseAmount("($1,234.56)")).toBe(-1234.56);
  });

  it("handles thousands separators (standard)", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("1,234,567.89")).toBe(1234567.89);
    expect(parseAmount("$1,234.56")).toBe(1234.56);
  });

  it("handles space thousands separator", () => {
    expect(parseAmount("1 234.56")).toBe(1234.56);
  });

  it("handles European format", () => {
    expect(parseAmount("1.234,56", true)).toBe(1234.56);
    expect(parseAmount("1.234.567,89", true)).toBe(1234567.89);
    expect(parseAmount("100,50", true)).toBe(100.5);
  });

  it("returns null for empty or invalid input", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseAmount("  100.50  ")).toBe(100.5);
  });

  it("handles negative with currency", () => {
    expect(parseAmount("-$100.00")).toBe(-100);
    expect(parseAmount("-EUR 50")).toBe(-50);
  });

  it("handles zero", () => {
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
  });

  it("handles large numbers", () => {
    expect(parseAmount("1,000,000.00")).toBe(1000000);
  });

  it("handles decimal-only amounts", () => {
    expect(parseAmount(".50")).toBe(0.5);
    expect(parseAmount("0.001")).toBe(0.001);
  });
});

describe("detectNumberFormat", () => {
  it("detects standard format", () => {
    expect(detectNumberFormat(["1,234.56", "2,345.67", "100.00"]).european).toBe(false);
  });

  it("detects European format", () => {
    expect(detectNumberFormat(["1.234,56", "2.345,67", "100,00"]).european).toBe(true);
  });

  it("handles empty input", () => {
    expect(detectNumberFormat([]).european).toBe(false);
  });

  it("handles ambiguous values", () => {
    // All simple integers — neither format wins
    expect(detectNumberFormat(["100", "200", "300"]).european).toBe(false);
  });

  it("European wins when comma is decimal", () => {
    expect(detectNumberFormat(["123,45", "678,90", "100,00"]).european).toBe(true);
  });

  it("standard wins when dot is decimal", () => {
    expect(detectNumberFormat(["123.45", "678.90", "100.00"]).european).toBe(false);
  });
});
