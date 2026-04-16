import { describe, it, expect, beforeEach } from "vitest";
import { wisePreset, setWiseRules, parseWiseDate } from "./wise.js";

const HEADERS = [
  "TransferWise ID", "Date", "Date Time", "Amount", "Currency", "Description",
  "Payment Reference", "Running Balance", "Exchange From", "Exchange To",
  "Exchange Rate", "Payer Name", "Payee Name", "Payee Account Number",
  "Merchant", "Card Last Four Digits", "Card Holder Full Name", "Attachment",
  "Note", "Total fees", "Exchange To Amount", "Transaction Type",
  "Transaction Details Type",
];

function makeRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    "TransferWise ID": "TW-123456",
    "Date": "15-01-2024",
    "Date Time": "15-01-2024 14:30:00",
    "Amount": "-50.00",
    "Currency": "EUR",
    "Description": "Coffee Shop",
    "Payment Reference": "",
    "Running Balance": "950.00",
    "Exchange From": "",
    "Exchange To": "",
    "Exchange Rate": "",
    "Payer Name": "",
    "Payee Name": "",
    "Payee Account Number": "",
    "Merchant": "",
    "Card Last Four Digits": "",
    "Card Holder Full Name": "",
    "Attachment": "",
    "Note": "",
    "Total fees": "0",
    "Exchange To Amount": "",
    "Transaction Type": "DEBIT",
    "Transaction Details Type": "CARD",
  };
  const merged = { ...defaults, ...overrides };
  return HEADERS.map((h) => merged[h] ?? "");
}

describe("parseWiseDate", () => {
  it("parses DD-MM-YYYY", () => {
    expect(parseWiseDate("15-01-2024")).toBe("2024-01-15");
    expect(parseWiseDate("01-12-2023")).toBe("2023-12-01");
    expect(parseWiseDate("28-02-2024")).toBe("2024-02-28");
  });

  it("rejects invalid dates", () => {
    expect(parseWiseDate("32-01-2024")).toBeNull();
    expect(parseWiseDate("15-13-2024")).toBeNull();
    expect(parseWiseDate("00-01-2024")).toBeNull();
    expect(parseWiseDate("2024-01-15")).toBeNull(); // wrong format
    expect(parseWiseDate("")).toBeNull();
  });

  it("validates days per month", () => {
    expect(parseWiseDate("29-02-2024")).toBe("2024-02-29"); // leap year
    expect(parseWiseDate("29-02-2023")).toBeNull(); // not leap year
    expect(parseWiseDate("31-04-2024")).toBeNull(); // April has 30 days
  });
});

describe("wisePreset", () => {
  beforeEach(() => {
    setWiseRules([]);
  });

  describe("detect", () => {
    it("scores 90 for Wise headers", () => {
      const score = wisePreset.detect(HEADERS, []);
      expect(score).toBe(90);
    });

    it("scores 0 for unrelated headers", () => {
      const score = wisePreset.detect(["Date", "Description", "Amount"], []);
      expect(score).toBe(0);
    });

    it("is case-insensitive", () => {
      const score = wisePreset.detect(
        HEADERS.map((h) => h.toLowerCase()),
        [],
      );
      expect(score).toBe(90);
    });
  });

  describe("transform — card payments", () => {
    it("transforms a card payment", () => {
      const rows = [makeRow({
        Amount: "-5.00",
        Currency: "EUR",
        Description: "Coffee Shop",
        Merchant: "STARBUCKS",
        "Transaction Details Type": "CARD",
        "Card Last Four Digits": "1234",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2024-01-15");
      expect(r.lines[0].account).toBe("Assets:Bank:Wise:EUR");
      expect(r.lines[0].currency).toBe("EUR");
      expect(r.lines[0].amount).toBe("-5");
      expect(r.lines[1].account).toBe("Expenses:Uncategorized");
      expect(r.lines[1].amount).toBe("5");
      expect(r.descriptionData).toEqual({ type: "bank", bank: "Wise", text: "STARBUCKS" });
      expect(r.metadata?.["card-last-four"]).toBe("1234");
    });

    it("prefers merchant over description for card payments", () => {
      const rows = [makeRow({
        Description: "Some description",
        Merchant: "MERCHANT NAME",
        "Transaction Details Type": "CARD",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].descriptionData).toEqual({ type: "bank", bank: "Wise", text: "MERCHANT NAME" });
    });

    it("falls back to description when no merchant", () => {
      const rows = [makeRow({
        Description: "Card purchase",
        Merchant: "",
        "Transaction Details Type": "CARD",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].descriptionData).toEqual({ type: "bank", bank: "Wise", text: "Card purchase" });
    });
  });

  describe("transform — transfers", () => {
    it("transforms an outgoing transfer", () => {
      const rows = [makeRow({
        Amount: "-500.00",
        Currency: "GBP",
        Description: "Rent payment",
        "Payee Name": "LANDLORD",
        "Transaction Details Type": "TRANSFER",
        "Payment Reference": "RENT-JAN-2024",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.lines[0].account).toBe("Assets:Bank:Wise:GBP");
      expect(r.lines[0].amount).toBe("-500");
      expect(r.lines[1].account).toBe("Expenses:Uncategorized");
      expect(r.metadata?.["payee"]).toBe("LANDLORD");
      expect(r.metadata?.["payment-reference"]).toBe("RENT-JAN-2024");
      expect(r.descriptionData).toEqual({ type: "bank", bank: "Wise", text: "Rent payment", reference: "RENT-JAN-2024" });
    });

    it("transforms an incoming transfer", () => {
      const rows = [makeRow({
        Amount: "3000.00",
        Currency: "EUR",
        Description: "Salary",
        "Payer Name": "EMPLOYER INC",
        "Transaction Type": "CREDIT",
        "Transaction Details Type": "TRANSFER",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      const r = records![0];
      expect(r.lines[0].amount).toBe("3000");
      expect(r.lines[1].account).toBe("Income:Uncategorized");
      expect(r.lines[1].amount).toBe("-3000");
      expect(r.metadata?.["payer"]).toBe("EMPLOYER INC");
    });

    it("builds description from counterparty when no description", () => {
      const rows = [makeRow({
        Amount: "-200.00",
        Description: "",
        "Payee Name": "JANE DOE",
        "Transaction Details Type": "TRANSFER",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].descriptionData).toEqual({
        type: "bank", bank: "Wise", text: "Transfer to JANE DOE",
      });
    });
  });

  describe("transform — conversions", () => {
    it("handles outflow conversion (selling EUR for GBP)", () => {
      const rows = [makeRow({
        Amount: "-100.00",
        Currency: "EUR",
        "Exchange From": "EUR",
        "Exchange To": "GBP",
        "Exchange Rate": "0.85",
        "Exchange To Amount": "85.00",
        "Transaction Details Type": "CONVERSION",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.lines).toHaveLength(4);

      // EUR leaves Wise EUR account
      expect(r.lines[0]).toEqual({ account: "Assets:Bank:Wise:EUR", currency: "EUR", amount: "-100" });
      // GBP arrives in Wise GBP account
      expect(r.lines[1]).toEqual({ account: "Assets:Bank:Wise:GBP", currency: "GBP", amount: "85" });
      // Equity balancing
      expect(r.lines[2]).toEqual({ account: "Equity:Trading", currency: "EUR", amount: "100" });
      expect(r.lines[3]).toEqual({ account: "Equity:Trading", currency: "GBP", amount: "-85" });

      expect(r.metadata?.["exchange-from"]).toBe("EUR");
      expect(r.metadata?.["exchange-to"]).toBe("GBP");
      expect(r.metadata?.["exchange-rate"]).toBe("0.85");
    });

    it("handles inflow conversion (receiving GBP from EUR)", () => {
      const rows = [makeRow({
        Amount: "85.00",
        Currency: "GBP",
        "Exchange From": "EUR",
        "Exchange To": "GBP",
        "Exchange Rate": "0.85",
        "Exchange To Amount": "85.00",
        "Transaction Details Type": "CONVERSION",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.lines).toHaveLength(4);

      // EUR leaves (derived: 85 / 0.85 = 100)
      expect(r.lines[0].account).toBe("Assets:Bank:Wise:EUR");
      expect(r.lines[0].currency).toBe("EUR");
      expect(parseFloat(r.lines[0].amount)).toBe(-100);

      // GBP arrives
      expect(r.lines[1]).toEqual({ account: "Assets:Bank:Wise:GBP", currency: "GBP", amount: "85" });
    });

    it("skips conversion with missing exchange info", () => {
      const rows = [makeRow({
        Amount: "-100.00",
        Currency: "EUR",
        "Exchange From": "",
        "Exchange To": "",
        "Transaction Details Type": "CONVERSION",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("includes conversion description", () => {
      const rows = [makeRow({
        Amount: "-100.00",
        Currency: "EUR",
        "Exchange From": "EUR",
        "Exchange To": "GBP",
        "Exchange Rate": "0.85",
        "Exchange To Amount": "85.00",
        "Transaction Details Type": "CONVERSION",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].descriptionData).toEqual({
        type: "bank", bank: "Wise", text: "Convert EUR \u2192 GBP",
      });
    });
  });

  describe("transform — fees", () => {
    it("adds fee line items", () => {
      const rows = [makeRow({
        Amount: "-100.00",
        Currency: "EUR",
        "Total fees": "1.50",
        "Transaction Details Type": "TRANSFER",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      const r = records![0];
      // 2 main lines + 2 fee lines
      expect(r.lines).toHaveLength(4);
      expect(r.lines[2]).toEqual({ account: "Expenses:Bank:Fees:Wise", currency: "EUR", amount: "1.5" });
      expect(r.lines[3]).toEqual({ account: "Assets:Bank:Wise:EUR", currency: "EUR", amount: "-1.5" });
      expect(r.metadata?.["total-fees"]).toBe("1.50");
    });

    it("adds fee lines to conversions", () => {
      const rows = [makeRow({
        Amount: "-100.00",
        Currency: "EUR",
        "Exchange From": "EUR",
        "Exchange To": "GBP",
        "Exchange Rate": "0.85",
        "Exchange To Amount": "85.00",
        "Total fees": "0.75",
        "Transaction Details Type": "CONVERSION",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      const r = records![0];
      // 4 conversion lines + 2 fee lines
      expect(r.lines).toHaveLength(6);
      expect(r.lines[4].account).toBe("Expenses:Bank:Fees:Wise");
      expect(r.lines[4].amount).toBe("0.75");
    });

    it("skips zero fees", () => {
      const rows = [makeRow({
        Amount: "-50.00",
        "Total fees": "0",
        "Transaction Details Type": "CARD",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].lines).toHaveLength(2);
    });
  });

  describe("transform — categorization rules", () => {
    it("applies matching categorization rules", () => {
      setWiseRules([
        { id: "1", pattern: "coffee", account: "Expenses:Coffee" },
      ]);

      const rows = [makeRow({
        Amount: "-5.00",
        Merchant: "Coffee Shop",
        "Transaction Details Type": "CARD",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].lines[1].account).toBe("Expenses:Coffee");
    });

    it("applies rules to transfers", () => {
      setWiseRules([
        { id: "2", pattern: "salary", account: "Income:Salary" },
      ]);

      const rows = [makeRow({
        Amount: "3000.00",
        Description: "Monthly salary",
        "Transaction Details Type": "TRANSFER",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].lines[1].account).toBe("Income:Salary");
    });
  });

  describe("transform — edge cases", () => {
    it("uses sourceKey from TransferWise ID", () => {
      const rows = [makeRow({ "TransferWise ID": "TW-999" })];
      const records = wisePreset.transform(HEADERS, rows);
      expect(records![0].sourceKey).toBe("TW-999");
    });

    it("skips zero-amount rows", () => {
      const rows = [makeRow({ Amount: "0" })];
      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips empty rows", () => {
      const records = wisePreset.transform(HEADERS, [[""]]);
      expect(records!).toHaveLength(0);
    });

    it("returns null when required columns missing", () => {
      const records = wisePreset.transform(["Foo", "Bar"], [["a", "b"]]);
      expect(records).toBeNull();
    });

    it("handles multiple currencies", () => {
      const rows = [
        makeRow({ Amount: "-50.00", Currency: "EUR", "TransferWise ID": "TW-1" }),
        makeRow({ Amount: "-30.00", Currency: "GBP", "TransferWise ID": "TW-2" }),
        makeRow({ Amount: "-20.00", Currency: "USD", "TransferWise ID": "TW-3" }),
      ];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(3);
      expect(records![0].lines[0].account).toBe("Assets:Bank:Wise:EUR");
      expect(records![1].lines[0].account).toBe("Assets:Bank:Wise:GBP");
      expect(records![2].lines[0].account).toBe("Assets:Bank:Wise:USD");
    });

    it("handles unknown transaction details type", () => {
      const rows = [makeRow({
        Amount: "-10.00",
        Description: "Unknown type",
        "Transaction Details Type": "DIRECT_DEBIT",
      })];

      const records = wisePreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);
      expect(records![0].lines[0].account).toBe("Assets:Bank:Wise:EUR");
      expect(records![0].lines[1].account).toBe("Expenses:Uncategorized");
    });
  });
});
