import { describe, it, expect } from "vitest";
import { parseQifDate, detectQifDateFormat, isTransfer, parseQif } from "./parse-qif.js";
import type { QifTransaction } from "./parse-qif.js";

describe("parseQifDate", () => {
  it("parses US date MM/DD/YY", () => {
    expect(parseQifDate("1/15/06", "MM/DD/YY")).toBe("2006-01-15");
    expect(parseQifDate("12/31/99", "MM/DD/YY")).toBe("1999-12-31");
    expect(parseQifDate("01/01/00", "MM/DD/YY")).toBe("2000-01-01");
  });

  it("parses US date MM/DD/YYYY", () => {
    expect(parseQifDate("1/15/2023", "MM/DD/YY")).toBe("2023-01-15");
    expect(parseQifDate("12/31/2020", "MM/DD/YY")).toBe("2020-12-31");
  });

  it("parses apostrophe notation for 2000s", () => {
    expect(parseQifDate("1/15'06", "MM/DD/YY")).toBe("2006-01-15");
    expect(parseQifDate("12/25'23", "MM/DD/YY")).toBe("2023-12-25");
  });

  it("parses European date DD/MM/YY", () => {
    expect(parseQifDate("15/1/06", "DD/MM/YY")).toBe("2006-01-15");
    expect(parseQifDate("31/12/99", "DD/MM/YY")).toBe("1999-12-31");
  });

  it("parses European date DD.MM.YY", () => {
    expect(parseQifDate("15.1.06", "DD.MM.YY")).toBe("2006-01-15");
    expect(parseQifDate("31.12.99", "DD.MM.YY")).toBe("1999-12-31");
  });

  it("parses European date DD-MM-YY", () => {
    expect(parseQifDate("15-1-06", "DD/MM/YY")).toBe("2006-01-15");
  });

  it("handles 2-digit year cutoff at 50", () => {
    expect(parseQifDate("1/1/49", "MM/DD/YY")).toBe("2049-01-01");
    expect(parseQifDate("1/1/50", "MM/DD/YY")).toBe("1950-01-01");
  });

  it("returns null for invalid input", () => {
    expect(parseQifDate("", "MM/DD/YY")).toBeNull();
    expect(parseQifDate("abc", "MM/DD/YY")).toBeNull();
    expect(parseQifDate("1/2", "MM/DD/YY")).toBeNull();
  });

  it("returns null for out-of-range month/day", () => {
    expect(parseQifDate("13/1/23", "MM/DD/YY")).toBeNull(); // month 13
    expect(parseQifDate("1/32/23", "MM/DD/YY")).toBeNull(); // day 32
    expect(parseQifDate("0/15/23", "MM/DD/YY")).toBeNull(); // month 0
  });
});

describe("detectQifDateFormat", () => {
  function makeTx(date: string): QifTransaction {
    return { date, amount: "100", splits: [] };
  }

  it("detects day-first when first position > 12", () => {
    const txs = [makeTx("15/1/06"), makeTx("20/3/06")];
    expect(detectQifDateFormat(txs)).toBe("DD/MM/YY");
  });

  it("detects month-first when second position > 12", () => {
    const txs = [makeTx("1/15/06"), makeTx("3/20/06")];
    expect(detectQifDateFormat(txs)).toBe("MM/DD/YY");
  });

  it("detects DD.MM.YY with dot separator", () => {
    const txs = [makeTx("15.1.06"), makeTx("20.3.06")];
    expect(detectQifDateFormat(txs)).toBe("DD.MM.YY");
  });

  it("defaults to MM/DD/YY when ambiguous", () => {
    const txs = [makeTx("1/2/06"), makeTx("3/4/06")];
    expect(detectQifDateFormat(txs)).toBe("MM/DD/YY");
  });

  it("handles empty transaction list", () => {
    expect(detectQifDateFormat([])).toBe("MM/DD/YY");
  });
});

describe("isTransfer", () => {
  it("detects transfer notation with brackets", () => {
    const result = isTransfer("[Savings Account]");
    expect(result).toEqual({ isTransfer: true, accountName: "Savings Account" });
  });

  it("returns false for regular categories", () => {
    expect(isTransfer("Groceries")).toEqual({ isTransfer: false });
    expect(isTransfer("Food:Groceries")).toEqual({ isTransfer: false });
  });

  it("handles whitespace around brackets", () => {
    const result = isTransfer("  [Checking]  ");
    expect(result).toEqual({ isTransfer: true, accountName: "Checking" });
  });

  it("returns false for partial brackets", () => {
    expect(isTransfer("[Incomplete")).toEqual({ isTransfer: false });
    expect(isTransfer("Incomplete]")).toEqual({ isTransfer: false });
  });
});

describe("parseQif", () => {
  it("parses a basic Bank section", () => {
    const qif = `!Type:Bank
D01/15/2023
T-50.00
PGrocery Store
MGroceries purchase
N1234
^
D01/16/2023
T100.00
PSalary Deposit
^`;
    const result = parseQif(qif);
    expect(result.warnings).toHaveLength(0);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe("Bank");
    expect(result.sections[0].transactions).toHaveLength(2);

    const tx1 = result.sections[0].transactions[0];
    expect(tx1.date).toBe("01/15/2023");
    expect(tx1.amount).toBe("-50.00");
    expect(tx1.payee).toBe("Grocery Store");
    expect(tx1.memo).toBe("Groceries purchase");
    expect(tx1.checkNum).toBe("1234");

    const tx2 = result.sections[0].transactions[1];
    expect(tx2.date).toBe("01/16/2023");
    expect(tx2.amount).toBe("100.00");
    expect(tx2.payee).toBe("Salary Deposit");
  });

  it("parses split transactions", () => {
    const qif = `!Type:Bank
D01/15/2023
T-100.00
PGrocery Store
SGroceries:Food
EFood items
$-60.00
SGroceries:Household
EHousehold items
$-40.00
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    const tx = result.sections[0].transactions[0];
    expect(tx.splits).toHaveLength(2);
    expect(tx.splits[0]).toEqual({ category: "Groceries:Food", memo: "Food items", amount: "-60.00" });
    expect(tx.splits[1]).toEqual({ category: "Groceries:Household", memo: "Household items", amount: "-40.00" });
  });

  it("parses transfers with bracket notation", () => {
    const qif = `!Type:Bank
D01/15/2023
T-500.00
PTransfer
L[Savings Account]
^`;
    const result = parseQif(qif);
    const tx = result.sections[0].transactions[0];
    expect(tx.category).toBe("[Savings Account]");
  });

  it("parses multiple sections in one file", () => {
    const qif = `!Account
NChecking
TBank
^
!Type:Bank
D01/15/2023
T-50.00
PGrocery
^
!Account
NVisa
TCCard
^
!Type:CCard
D01/16/2023
T-25.00
PRestaurant
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].type).toBe("Bank");
    expect(result.sections[0].account?.name).toBe("Checking");
    expect(result.sections[0].transactions).toHaveLength(1);
    expect(result.sections[1].type).toBe("CCard");
    expect(result.sections[1].account?.name).toBe("Visa");
    expect(result.sections[1].transactions).toHaveLength(1);
  });

  it("skips investment sections with warning", () => {
    const qif = `!Type:Invst
D01/15/2023
NBUY
YAAPL
T-5000.00
^
!Type:Bank
D01/16/2023
T100.00
PSalary
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe("Bank");
    expect(result.warnings.some((w) => w.includes("investment"))).toBe(true);
  });

  it("skips memorized transactions with warning", () => {
    const qif = `!Type:Memorized
PElectric Company
T-150.00
^
!Type:Bank
D01/16/2023
T100.00
PSalary
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("memorized"))).toBe(true);
  });

  it("handles malformed records gracefully", () => {
    const qif = `!Type:Bank
PNo date or amount
^
D01/15/2023
T-50.00
PValid
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].transactions).toHaveLength(1);
    expect(result.sections[0].transactions[0].payee).toBe("Valid");
    expect(result.warnings.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("handles empty file", () => {
    const result = parseQif("");
    expect(result.sections).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("handles file with only headers", () => {
    const result = parseQif("!Type:Bank\n^");
    expect(result.sections).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("handles CRLF line endings", () => {
    const qif = "!Type:Bank\r\nD01/15/2023\r\nT-50.00\r\nPGrocery\r\n^\r\n";
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].transactions).toHaveLength(1);
  });

  it("handles CR-only line endings", () => {
    const qif = "!Type:Bank\rD01/15/2023\rT-50.00\rPGrocery\r^\r";
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].transactions).toHaveLength(1);
  });

  it("parses cleared status", () => {
    const qif = `!Type:Bank
D01/15/2023
T-50.00
C*
PGrocery
^`;
    const result = parseQif(qif);
    expect(result.sections[0].transactions[0].cleared).toBe("*");
  });

  it("parses address lines", () => {
    const qif = `!Type:Bank
D01/15/2023
T-50.00
PPayee
A123 Main St
AApt 4
ASpringfield, IL 62701
^`;
    const result = parseQif(qif);
    const tx = result.sections[0].transactions[0];
    expect(tx.address).toEqual(["123 Main St", "Apt 4", "Springfield, IL 62701"]);
  });

  it("prefers U amount field when present", () => {
    const qif = `!Type:Bank
D01/15/2023
T-50.00
U-50.005
PGrocery
^`;
    const result = parseQif(qif);
    const tx = result.sections[0].transactions[0];
    expect(tx.amount).toBe("-50.00");
    expect(tx.amountU).toBe("-50.005");
  });

  it("strips US thousand separators from T and U amounts", () => {
    const qif = `!Type:Bank
D01/15/2023
T-1,234.56
U-1,234.567
PBig purchase
^`;
    const result = parseQif(qif);
    const tx = result.sections[0].transactions[0];
    expect(tx.amount).toBe("-1234.56");
    expect(tx.amountU).toBe("-1234.567");
  });

  it("handles all supported account types", () => {
    for (const type of ["Bank", "CCard", "Cash", "Oth A", "Oth L"]) {
      const qif = `!Type:${type}\nD01/15/2023\nT-50.00\nPTest\n^`;
      const result = parseQif(qif);
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].type).toBe(type);
    }
  });

  it("silently skips Cat and Class sections", () => {
    const qif = `!Type:Cat
NGroceries
E1
^
!Type:Class
NPersonal
^
!Type:Bank
D01/15/2023
T-50.00
PGrocery
^`;
    const result = parseQif(qif);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe("Bank");
    // Cat and Class should not produce warnings about skipping
    expect(result.warnings).toHaveLength(0);
  });

  it("parses account header description", () => {
    const qif = `!Account
NChecking
TBank
DMain checking account
^
!Type:Bank
D01/15/2023
T-50.00
PGrocery
^`;
    const result = parseQif(qif);
    expect(result.sections[0].account?.name).toBe("Checking");
    expect(result.sections[0].account?.type).toBe("Bank");
    expect(result.sections[0].account?.description).toBe("Main checking account");
  });
});
