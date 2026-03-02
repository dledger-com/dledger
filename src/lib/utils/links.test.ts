import { describe, it, expect } from "vitest";
import { normalizeLink, parseLinks, serializeLinksForExport, linkColor } from "./links.js";

describe("normalizeLink", () => {
  it("trims and lowercases", () => {
    expect(normalizeLink("  Invoice-Jan  ")).toBe("invoice-jan");
  });

  it("strips ^ prefix", () => {
    expect(normalizeLink("^invoice-jan")).toBe("invoice-jan");
  });

  it("strips multiple ^ prefixes", () => {
    expect(normalizeLink("^^link")).toBe("link");
  });

  it("preserves hyphens and underscores", () => {
    expect(normalizeLink("long-term_hold")).toBe("long-term_hold");
  });

  it("preserves accented characters", () => {
    expect(normalizeLink("facture-été")).toBe("facture-été");
  });

  it("strips invalid characters", () => {
    expect(normalizeLink("hello!@#$world")).toBe("helloworld");
  });

  it("returns empty for only-invalid input", () => {
    expect(normalizeLink("^^^")).toBe("");
  });
});

describe("parseLinks", () => {
  it("returns empty array for undefined", () => {
    expect(parseLinks(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseLinks("")).toEqual([]);
  });

  it("parses beancount ^-prefixed format", () => {
    expect(parseLinks("^invoice-jan ^payment-jan")).toEqual(["invoice-jan", "payment-jan"]);
  });

  it("handles links without ^ prefix", () => {
    expect(parseLinks("link1 link2")).toEqual(["link1", "link2"]);
  });

  it("handles extra whitespace", () => {
    expect(parseLinks("  ^link1   ^link2  ")).toEqual(["link1", "link2"]);
  });

  it("lowercases links", () => {
    expect(parseLinks("^Invoice ^PAYMENT")).toEqual(["invoice", "payment"]);
  });

  it("handles single link", () => {
    expect(parseLinks("^my-link")).toEqual(["my-link"]);
  });

  it("filters empty tokens", () => {
    expect(parseLinks("^valid ^ ^ok")).toEqual(["valid", "ok"]);
  });
});

describe("serializeLinksForExport", () => {
  it("joins with ^ prefix and spaces", () => {
    expect(serializeLinksForExport(["invoice", "payment"])).toBe("^invoice ^payment");
  });

  it("normalizes before serializing", () => {
    expect(serializeLinksForExport(["^Invoice", "PAYMENT"])).toBe("^invoice ^payment");
  });

  it("filters empty links", () => {
    expect(serializeLinksForExport(["valid", "###", "ok"])).toBe("^valid ^ok");
  });

  it("returns empty string for empty array", () => {
    expect(serializeLinksForExport([])).toBe("");
  });
});

describe("linkColor", () => {
  it("returns deterministic color for same input", () => {
    const c1 = linkColor("invoice");
    const c2 = linkColor("invoice");
    expect(c1).toBe(c2);
  });

  it("returns a string containing Tailwind classes", () => {
    const color = linkColor("test");
    expect(color).toMatch(/bg-\w+-\d+/);
    expect(color).toMatch(/text-\w+-\d+/);
  });

  it("uses different palette than tags", () => {
    // Link colors use indigo/rose/emerald/fuchsia/sky/lime/yellow/red
    const color = linkColor("test");
    expect(color).toMatch(/indigo|rose|emerald|fuchsia|sky|lime|yellow|red/);
  });

  it("returns different colors for different links", () => {
    const colors = new Set(["a", "b", "invoice", "payment", "transfer", "refund", "batch", "order"].map(linkColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
