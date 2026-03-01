import { describe, it, expect } from "vitest";
import { parseTags, serializeTags, normalizeTag, tagColor, TAGS_META_KEY } from "./tags.js";

describe("TAGS_META_KEY", () => {
  it("is 'tags'", () => {
    expect(TAGS_META_KEY).toBe("tags");
  });
});

describe("normalizeTag", () => {
  it("trims and lowercases", () => {
    expect(normalizeTag("  Groceries  ")).toBe("groceries");
  });

  it("preserves hyphens and underscores", () => {
    expect(normalizeTag("long-term_hold")).toBe("long-term_hold");
  });

  it("preserves accented characters", () => {
    expect(normalizeTag("épicerie")).toBe("épicerie");
  });

  it("preserves CJK characters", () => {
    expect(normalizeTag("食品")).toBe("食品");
  });

  it("strips invalid characters", () => {
    expect(normalizeTag("hello!@#$world")).toBe("helloworld");
  });

  it("strips commas and hash signs", () => {
    expect(normalizeTag("#tag,name")).toBe("tagname");
  });

  it("returns empty for only-invalid input", () => {
    expect(normalizeTag("###")).toBe("");
  });
});

describe("parseTags", () => {
  it("returns empty array for undefined", () => {
    expect(parseTags(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTags("")).toEqual([]);
  });

  it("parses comma-separated format", () => {
    expect(parseTags("groceries,food,monthly")).toEqual(["groceries", "food", "monthly"]);
  });

  it("handles whitespace in comma format", () => {
    expect(parseTags(" groceries , food ")).toEqual(["groceries", "food"]);
  });

  it("filters empty segments", () => {
    expect(parseTags("a,,b,")).toEqual(["a", "b"]);
  });

  it("parses beancount #-prefixed format", () => {
    expect(parseTags("#groceries #food")).toEqual(["groceries", "food"]);
  });

  it("handles beancount with extra whitespace", () => {
    expect(parseTags("  #groceries   #food  ")).toEqual(["groceries", "food"]);
  });

  it("lowercases tags", () => {
    expect(parseTags("Groceries,FOOD")).toEqual(["groceries", "food"]);
  });

  it("handles single beancount tag", () => {
    expect(parseTags("#personal")).toEqual(["personal"]);
  });
});

describe("serializeTags", () => {
  it("joins normalized tags with commas", () => {
    expect(serializeTags(["Groceries", "food"])).toBe("groceries,food");
  });

  it("filters empty tags after normalization", () => {
    expect(serializeTags(["valid", "###", "ok"])).toBe("valid,ok");
  });

  it("returns empty string for empty array", () => {
    expect(serializeTags([])).toBe("");
  });
});

describe("tagColor", () => {
  it("returns deterministic color for same input", () => {
    const c1 = tagColor("groceries");
    const c2 = tagColor("groceries");
    expect(c1).toBe(c2);
  });

  it("returns a string containing Tailwind classes", () => {
    const color = tagColor("test");
    expect(color).toMatch(/bg-\w+-\d+/);
    expect(color).toMatch(/text-\w+-\d+/);
  });

  it("returns different colors for different tags", () => {
    // Not guaranteed for all inputs, but these specific strings hash differently
    const colors = new Set(["a", "b", "groceries", "rent", "salary", "food", "travel", "gym"].map(tagColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
