import { describe, it, expect } from "vitest";
import { matchRule, type CsvCategorizationRule } from "./categorize.js";

const rules: CsvCategorizationRule[] = [
  { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
  { id: "2", pattern: "grocery", account: "Expenses:Groceries" },
  { id: "3", pattern: "salary", account: "Income:Salary" },
  { id: "4", pattern: "amazon", account: "Expenses:Shopping" },
];

describe("matchRule", () => {
  it("matches first matching rule", () => {
    const result = matchRule("Morning coffee at Starbucks", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Coffee");
  });

  it("is case-insensitive", () => {
    const result = matchRule("COFFEE SHOP", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Coffee");
  });

  it("returns null when no match", () => {
    const result = matchRule("Electric bill payment", rules);
    expect(result).toBeNull();
  });

  it("returns null for empty description", () => {
    const result = matchRule("", rules);
    expect(result).toBeNull();
  });

  it("returns null for empty rules", () => {
    const result = matchRule("coffee", []);
    expect(result).toBeNull();
  });

  it("matches first rule when multiple could match", () => {
    const multiRules: CsvCategorizationRule[] = [
      { id: "1", pattern: "shop", account: "Expenses:Shopping" },
      { id: "2", pattern: "coffee shop", account: "Expenses:Coffee" },
    ];
    const result = matchRule("coffee shop visit", multiRules);
    expect(result!.account).toBe("Expenses:Shopping"); // first match wins
  });

  it("matches substring anywhere in description", () => {
    const result = matchRule("payment at Amazon.com for books", rules);
    expect(result).not.toBeNull();
    expect(result!.account).toBe("Expenses:Shopping");
  });

  it("skips rules with empty pattern", () => {
    const rulesWithEmpty: CsvCategorizationRule[] = [
      { id: "1", pattern: "", account: "Expenses:Misc" },
      { id: "2", pattern: "coffee", account: "Expenses:Coffee" },
    ];
    const result = matchRule("coffee", rulesWithEmpty);
    expect(result!.account).toBe("Expenses:Coffee");
  });
});
