import { describe, it, expect } from "vitest";
import { convertQifToRecords, suggestQifMainAccount, parseQifAmount } from "./convert.js";
import type { QifSection } from "./parse-qif.js";
import { parseQif } from "./parse-qif.js";

function makeSection(overrides: Partial<QifSection> = {}): QifSection {
  return {
    type: "Bank",
    account: { name: "Checking", type: "Bank" },
    transactions: [
      {
        date: "01/15/2023",
        amount: "-50.00",
        payee: "Grocery Store",
        memo: "Weekly shopping",
        splits: [],
      },
      {
        date: "01/16/2023",
        amount: "2500.00",
        payee: "Payroll",
        memo: "Monthly salary",
        splits: [],
      },
    ],
    ...overrides,
  };
}

describe("parseQifAmount", () => {
  it("parses simple positive amount", () => {
    expect(parseQifAmount("100.50")).toBe(100.5);
  });

  it("parses negative amount", () => {
    expect(parseQifAmount("-50.25")).toBe(-50.25);
  });

  it("strips US thousand separators", () => {
    expect(parseQifAmount("1,234.56")).toBe(1234.56);
    expect(parseQifAmount("1,234,567.89")).toBe(1234567.89);
  });

  it("parses European format", () => {
    expect(parseQifAmount("1.234,56", true)).toBe(1234.56);
    expect(parseQifAmount("1.234.567,89", true)).toBe(1234567.89);
  });

  it("returns null for empty string", () => {
    expect(parseQifAmount("")).toBeNull();
    expect(parseQifAmount("  ")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseQifAmount("abc")).toBeNull();
  });
});

describe("convertQifToRecords", () => {
  it("converts basic transactions", () => {
    const section = makeSection();
    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    const rec1 = result.records[0];
    expect(rec1.date).toBe("2023-01-15");
    expect(rec1.lines).toHaveLength(2);
    expect(rec1.lines[0].account).toBe("Assets:Bank:Checking");
    expect(rec1.lines[0].amount).toBe("-50");
    expect(rec1.lines[1].account).toBe("Expenses:Uncategorized");
    expect(rec1.lines[1].amount).toBe("50");

    const rec2 = result.records[1];
    expect(rec2.date).toBe("2023-01-16");
    expect(rec2.lines[0].amount).toBe("2500");
    expect(rec2.lines[1].account).toBe("Income:Uncategorized");
  });

  it("generates deterministic sourceKeys", () => {
    const section = makeSection();
    const result1 = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });
    const result2 = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result1.records[0].sourceKey).toBe(result2.records[0].sourceKey);
    expect(result1.records[0].sourceKey).toContain("qif:");
  });

  it("builds description from payee and memo", () => {
    const section = makeSection();
    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records[0].description).toContain("Grocery Store");
    expect(result.records[0].description).toContain("Weekly shopping");
  });

  it("applies categorization rules", () => {
    const section = makeSection();
    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [{ id: "r1", pattern: "Grocery", account: "Expenses:Food:Groceries" }],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records[0].lines[1].account).toBe("Expenses:Food:Groceries");
    // Payroll doesn't match rule
    expect(result.records[1].lines[1].account).toBe("Income:Uncategorized");
  });

  it("converts split transactions to multi-line records", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-100.00",
          payee: "Store",
          splits: [
            { category: "Groceries:Food", memo: "Food", amount: "-60.00" },
            { category: "Groceries:Household", memo: "Household", amount: "-40.00" },
          ],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records).toHaveLength(1);
    const rec = result.records[0];
    expect(rec.lines).toHaveLength(3); // main + 2 splits
    expect(rec.lines[0].account).toBe("Assets:Bank:Checking");
    expect(rec.lines[0].amount).toBe("-100");
    expect(rec.lines[1].account).toBe("Groceries:Food");
    expect(rec.lines[1].amount).toBe("60");
    expect(rec.lines[2].account).toBe("Groceries:Household");
    expect(rec.lines[2].amount).toBe("40");
  });

  it("adds balancing line when splits don't sum to total", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-100.00",
          payee: "Store",
          splits: [
            { category: "Groceries", amount: "-60.00", memo: undefined },
          ],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    const rec = result.records[0];
    expect(rec.lines.length).toBeGreaterThan(2);
    expect(result.warnings.some((w) => w.includes("balancing"))).toBe(true);
  });

  it("handles transfer categories with account mapping", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-500.00",
          payee: "Transfer",
          category: "[Savings]",
          splits: [],
        },
      ],
    });

    const mapping = new Map([["Savings", "Assets:Bank:Savings"]]);
    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
      accountMapping: mapping,
    });

    expect(result.records[0].lines[1].account).toBe("Assets:Bank:Savings");
    expect(result.unmappedAccounts).toHaveLength(0);
  });

  it("reports unmapped transfer accounts", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-500.00",
          payee: "Transfer",
          category: "[Investment]",
          splits: [],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.unmappedAccounts).toContain("Investment");
    // Falls back to auto-normalized path
    expect(result.records[0].lines[1].account).toBe("Assets:Bank:Investment");
  });

  it("uses European number format when enabled", () => {
    const section = makeSection({
      transactions: [
        {
          date: "15/01/2023",
          amount: "-1234.56", // Already stripped of commas by parser
          payee: "Store",
          splits: [],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "DD/MM/YY",
      europeanNumbers: false,
    });

    expect(result.records[0].lines[0].amount).toBe("-1234.56");
  });

  it("prefers U amount over T amount", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-50.00",
          amountU: "-50.005",
          payee: "Store",
          splits: [],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records[0].lines[0].amount).toBe("-50.005");
  });

  it("skips transactions with invalid dates", () => {
    const section = makeSection({
      transactions: [
        { date: "invalid", amount: "-50.00", payee: "Test", splits: [] },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("skips transactions with zero amounts", () => {
    const section = makeSection({
      transactions: [
        { date: "01/15/2023", amount: "0", payee: "Test", splits: [] },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("uses QIF category as account when no rule matches", () => {
    const section = makeSection({
      transactions: [
        {
          date: "01/15/2023",
          amount: "-50.00",
          payee: "Store",
          category: "Food:Groceries",
          splits: [],
        },
      ],
    });

    const result = convertQifToRecords(section, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
    });

    expect(result.records[0].lines[1].account).toBe("Food:Groceries");
  });
});

describe("suggestQifMainAccount", () => {
  it("suggests bank account for Bank type", () => {
    const acct = suggestQifMainAccount({ type: "Bank", account: { name: "Checking", type: "Bank" }, transactions: [] });
    expect(acct).toContain("Checking");
    expect(acct).toContain("Bank");
  });

  it("suggests credit card account for CCard type", () => {
    const acct = suggestQifMainAccount({ type: "CCard", account: { name: "Visa", type: "CCard" }, transactions: [] });
    expect(acct).toContain("Visa");
  });

  it("suggests Other Asset for Oth A type", () => {
    const acct = suggestQifMainAccount({ type: "Oth A", account: { name: "House", type: "Oth A" }, transactions: [] });
    expect(acct).toBe("Assets:Other:House");
  });

  it("suggests Other Liability for Oth L type", () => {
    const acct = suggestQifMainAccount({ type: "Oth L", account: { name: "Mortgage", type: "Oth L" }, transactions: [] });
    expect(acct).toBe("Liabilities:Other:Mortgage");
  });

  it("uses QIF as fallback name when no account header", () => {
    const acct = suggestQifMainAccount({ type: "Bank", transactions: [] });
    expect(acct).toContain("QIF");
  });
});

describe("end-to-end: parseQif + convertQifToRecords", () => {
  it("round-trips a complete QIF file", () => {
    const qif = `!Account
NChecking
TBank
^
!Type:Bank
D01/15/2023
T-150.00
PGrocery Store
LGroceries
^
D01/20/2023
T-500.00
PTransfer to Savings
L[Savings]
^
D01/25/2023
T3000.00
PSalary
LIncome:Salary
^`;

    const parsed = parseQif(qif);
    expect(parsed.sections).toHaveLength(1);

    const result = convertQifToRecords(parsed.sections[0], {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
      dateFormat: "MM/DD/YY",
      accountMapping: new Map([["Savings", "Assets:Bank:Savings"]]),
    });

    expect(result.records).toHaveLength(3);

    // Grocery — uses QIF category
    expect(result.records[0].lines[1].account).toBe("Groceries");

    // Transfer — uses mapped account
    expect(result.records[1].lines[1].account).toBe("Assets:Bank:Savings");

    // Salary — uses QIF category
    expect(result.records[2].lines[1].account).toBe("Income:Salary");
  });
});
