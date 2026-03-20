import { describe, it, expect } from "vitest";
import { convertOfxToRecords, suggestMainAccount } from "./convert.js";
import type { OfxStatement } from "./parse-ofx.js";
import { parseOfx } from "./parse-ofx.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";

function makeStatement(overrides: Partial<OfxStatement> = {}): OfxStatement {
  return {
    currency: "USD",
    account: { acctId: "123456789", acctType: "CHECKING", accountType: "bank" },
    transactions: [
      {
        trnType: "DEBIT",
        dtPosted: "20230401",
        trnAmt: "-50.00",
        fitId: "TX001",
        name: "Grocery Store",
      },
      {
        trnType: "CREDIT",
        dtPosted: "20230405",
        trnAmt: "2500.00",
        fitId: "TX002",
        name: "Payroll",
        memo: "Monthly salary",
      },
    ],
    ...overrides,
  };
}

describe("convertOfxToRecords", () => {
  it("converts basic transactions", () => {
    const stmt = makeStatement();
    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    const rec1 = result.records[0];
    expect(rec1.date).toBe("2023-04-01");
    expect(rec1.description).toBe("Checking: Grocery Store");
    expect(rec1.lines).toHaveLength(2);
    expect(rec1.lines[0]).toEqual({
      account: "Assets:Bank:Checking",
      currency: "USD",
      amount: "-50",
    });
    expect(rec1.lines[1]).toEqual({
      account: "Expenses:Uncategorized",
      currency: "USD",
      amount: "50",
    });

    const rec2 = result.records[1];
    expect(rec2.date).toBe("2023-04-05");
    expect(rec2.description).toBe("Checking: Payroll - Monthly salary");
    expect(rec2.lines[0].amount).toBe("2500");
    expect(rec2.lines[1].account).toBe("Income:Uncategorized");
  });

  it("maps FITID to sourceKey", () => {
    const stmt = makeStatement();
    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records[0].sourceKey).toBe("TX001");
    expect(result.records[1].sourceKey).toBe("TX002");
  });

  it("builds description from NAME + MEMO", () => {
    const stmt = makeStatement({
      transactions: [
        { trnType: "DEBIT", dtPosted: "20230401", trnAmt: "-10", fitId: "T1", name: "Store", memo: "Dept A" },
        { trnType: "DEBIT", dtPosted: "20230402", trnAmt: "-20", fitId: "T2", name: "Only Name" },
        { trnType: "DEBIT", dtPosted: "20230403", trnAmt: "-30", fitId: "T3", memo: "Only Memo" },
        { trnType: "DEBIT", dtPosted: "20230404", trnAmt: "-40", fitId: "T4" },
      ],
    });

    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records[0].description).toBe("Checking: Store - Dept A");
    expect(result.records[1].description).toBe("Checking: Only Name");
    expect(result.records[2].description).toBe("Checking: Only Memo");
    expect(result.records[3].description).toBe("Checking: DEBIT"); // fallback to trnType
  });

  it("respects amount signs (negative=expense, positive=income)", () => {
    const stmt = makeStatement({
      transactions: [
        { trnType: "DEBIT", dtPosted: "20230401", trnAmt: "-100.50", fitId: "D1", name: "Expense" },
        { trnType: "CREDIT", dtPosted: "20230402", trnAmt: "200.75", fitId: "C1", name: "Income" },
      ],
    });

    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records[0].lines[1].account).toBe("Expenses:Uncategorized");
    expect(result.records[1].lines[1].account).toBe("Income:Uncategorized");
  });

  it("applies categorization rules", () => {
    const rules: CsvCategorizationRule[] = [
      { id: "1", pattern: "grocery", account: "Expenses:Groceries" },
      { id: "2", pattern: "payroll", account: "Income:Salary" },
    ];

    const stmt = makeStatement();
    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules,
    });

    expect(result.records[0].lines[1].account).toBe("Expenses:Groceries");
    expect(result.records[1].lines[1].account).toBe("Income:Salary");
  });

  it("builds CsvFileHeader from balance info", () => {
    const stmt = makeStatement({
      ledgerBalance: { balAmt: "5430.25", dtAsOf: "20230415" },
    });

    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.fileHeader.balanceDate).toBe("2023-04-15");
    expect(result.fileHeader.balanceAmount).toBe("5430.25");
    expect(result.fileHeader.balanceCurrency).toBe("USD");
    expect(result.fileHeader.accountMetadata?.accountID).toBe("123456789");
  });

  it("handles empty statement", () => {
    const stmt = makeStatement({ transactions: [] });
    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns and skips invalid transactions", () => {
    const stmt = makeStatement({
      transactions: [
        { trnType: "DEBIT", dtPosted: "invalid", trnAmt: "-10", fitId: "BAD1", name: "Bad date" },
        { trnType: "DEBIT", dtPosted: "20230401", trnAmt: "abc", fitId: "BAD2", name: "Bad amount" },
        { trnType: "DEBIT", dtPosted: "20230401", trnAmt: "0", fitId: "BAD3", name: "Zero amount" },
        { trnType: "DEBIT", dtPosted: "20230401", trnAmt: "-50", fitId: "GOOD1", name: "Valid" },
      ],
    });

    const result = convertOfxToRecords(stmt, {
      mainAccount: "Assets:Bank:Checking",
      rules: [],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].sourceKey).toBe("GOOD1");
    expect(result.warnings).toHaveLength(3);
  });
});

describe("suggestMainAccount", () => {
  it("suggests bank account from account info", () => {
    const stmt = makeStatement();
    expect(suggestMainAccount(stmt)).toBe("Assets:Bank:CHECKING:6789");
  });

  it("suggests credit card account", () => {
    const stmt = makeStatement({
      account: { acctId: "4111222233334444", accountType: "creditcard" },
    });
    expect(suggestMainAccount(stmt)).toBe("Liabilities:CreditCards:4444");
  });

  it("handles missing acctId", () => {
    const stmt = makeStatement({
      account: { acctType: "SAVINGS", accountType: "bank" },
    });
    expect(suggestMainAccount(stmt)).toBe("Assets:Bank:SAVINGS:Unknown");
  });
});

describe("integration: parse → convert", () => {
  it("parses then converts a full OFX file", () => {
    const ofx = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>EUR
<BANKACCTFROM>
<BANKID>BNPP
<ACCTID>FR7612345
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20230601
<TRNAMT>-42.50
<FITID>EU001
<NAME>Boulangerie
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20230615
<TRNAMT>3200.00
<FITID>EU002
<NAME>Salaire
<MEMO>Juin 2023
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>8500.00
<DTASOF>20230630
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const parsed = parseOfx(ofx);
    expect(parsed.statements).toHaveLength(1);

    const result = convertOfxToRecords(parsed.statements[0], {
      mainAccount: "Assets:Bank:BNPP",
      rules: [{ id: "1", pattern: "salaire", account: "Income:Salary" }],
    });

    expect(result.records).toHaveLength(2);
    expect(result.records[0].date).toBe("2023-06-01");
    expect(result.records[0].lines[0].currency).toBe("EUR");
    expect(result.records[0].sourceKey).toBe("EU001");

    expect(result.records[1].lines[1].account).toBe("Income:Salary");
    expect(result.records[1].description).toBe("BNPP: Salaire - Juin 2023");

    expect(result.fileHeader.balanceAmount).toBe("8500.00");
    expect(result.fileHeader.balanceDate).toBe("2023-06-30");
    expect(result.fileHeader.balanceCurrency).toBe("EUR");
  });
});
