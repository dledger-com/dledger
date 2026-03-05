import { describe, it, expect } from "vitest";
import {
  guessFromExtension,
  detectFromContent,
  detectImportTarget,
} from "./import-detect.js";

describe("guessFromExtension", () => {
  it("maps .csv → csv", () => expect(guessFromExtension("data.csv")).toBe("csv"));
  it("maps .tsv → csv", () => expect(guessFromExtension("data.tsv")).toBe("csv"));
  it("maps .ofx → ofx", () => expect(guessFromExtension("bank.ofx")).toBe("ofx"));
  it("maps .qfx → ofx", () => expect(guessFromExtension("bank.qfx")).toBe("ofx"));
  it("maps .qbo → ofx", () => expect(guessFromExtension("bank.qbo")).toBe("ofx"));
  it("maps .pdf → pdf", () => expect(guessFromExtension("stmt.pdf")).toBe("pdf"));
  it("maps .ledger → ledger", () => expect(guessFromExtension("main.ledger")).toBe("ledger"));
  it("maps .beancount → ledger", () => expect(guessFromExtension("main.beancount")).toBe("ledger"));
  it("maps .journal → ledger", () => expect(guessFromExtension("main.journal")).toBe("ledger"));
  it("maps .hledger → ledger", () => expect(guessFromExtension("main.hledger")).toBe("ledger"));
  it("maps .zip → ledger", () => expect(guessFromExtension("archive.zip")).toBe("ledger"));
  it("returns null for unknown", () => expect(guessFromExtension("file.png")).toBeNull());
  it("returns null for no extension", () => expect(guessFromExtension("README")).toBeNull());
  it("is case-insensitive", () => expect(guessFromExtension("DATA.CSV")).toBe("csv"));
});

describe("detectFromContent", () => {
  it("detects PDF from magic bytes", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
    expect(detectFromContent(null, bytes)).toBe("pdf");
  });

  it("detects OFX from OFXHEADER:", () => {
    expect(detectFromContent("OFXHEADER:100\nDATA:OFXSGML", null)).toBe("ofx");
  });

  it("detects OFX from <OFX> tag", () => {
    expect(detectFromContent('<?xml version="1.0"?>\n<OFX>\n<SIGNONMSGSRSV1>', null)).toBe("ofx");
  });

  it("detects ledger from beancount content", () => {
    const content = [
      'option "title" "Test"',
      'option "operating_currency" "EUR"',
      "",
      "2024-01-01 open Assets:Bank:Checking EUR",
      "2024-01-01 open Expenses:Food EUR",
      "",
      '2024-01-15 txn "Grocery Store"',
      "  Expenses:Food  42.50 EUR",
      "  Assets:Bank:Checking",
    ].join("\n");
    expect(detectFromContent(content, null)).toBe("ledger");
  });

  it("detects ledger from hledger content", () => {
    const content = [
      "account Assets:Bank:Checking",
      "account Expenses:Food",
      "commodity EUR",
      "",
      "2024/01/15 Grocery Store",
      "  Expenses:Food  42.50 EUR",
      "  Assets:Bank:Checking",
    ].join("\n");
    expect(detectFromContent(content, null)).toBe("ledger");
  });

  it("falls back to csv for plain delimited text", () => {
    const content = "date,amount,description\n2024-01-01,42.50,Groceries\n";
    expect(detectFromContent(content, null)).toBe("csv");
  });

  it("returns null for empty content and no bytes", () => {
    expect(detectFromContent(null, null)).toBeNull();
  });
});

describe("detectImportTarget", () => {
  function makeFile(name: string, content: string): File {
    return new File([content], name, { type: "text/plain" });
  }

  function makeBinaryFile(name: string, bytes: Uint8Array): File {
    return new File([bytes], name, { type: "application/octet-stream" });
  }

  it(".csv file with CSV content → csv", async () => {
    const file = makeFile("data.csv", "date,amount\n2024-01-01,42\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("csv");
    expect(result?.text).toBeDefined();
  });

  it(".ofx file with OFXHEADER content → ofx", async () => {
    const file = makeFile("bank.ofx", "OFXHEADER:100\nDATA:OFXSGML\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ofx");
    expect(result?.text).toBeDefined();
  });

  it(".pdf file with %PDF- bytes → pdf", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const file = makeBinaryFile("stmt.pdf", bytes);
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("pdf");
    expect(result?.bytes).toBeDefined();
  });

  it(".beancount file with beancount content → ledger", async () => {
    const content = [
      'option "title" "Test"',
      "2024-01-01 open Assets:Bank EUR",
      '2024-01-15 txn "Shop"',
      "  Expenses:Food  10 EUR",
      "  Assets:Bank",
    ].join("\n");
    const file = makeFile("main.beancount", content);
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ledger");
  });

  it(".txt file with beancount content → ledger (content override)", async () => {
    const content = [
      'option "title" "Test"',
      "2024-01-01 open Assets:Bank EUR",
      '2024-01-15 txn "Shop"',
      "  Expenses:Food  10 EUR",
      "  Assets:Bank",
    ].join("\n");
    const file = makeFile("export.txt", content);
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ledger");
  });

  it(".txt file with CSV content → csv (fallback)", async () => {
    const file = makeFile("data.txt", "date,amount,desc\n2024-01-01,42,Groceries\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("csv");
  });

  it(".csv file with OFX content → ofx (content overrides extension)", async () => {
    const file = makeFile("misnamed.csv", "OFXHEADER:100\nDATA:OFXSGML\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ofx");
  });

  it("unknown extension with OFX content → ofx", async () => {
    const file = makeFile("bank.xyz", "OFXHEADER:100\nDATA:OFXSGML\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ofx");
  });

  it("empty content + unknown extension → csv fallback", async () => {
    // detectFromContent returns "csv" as fallback for any non-empty text
    const file = makeFile("file.xyz", "some random data\n");
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("csv");
  });

  it(".zip file → ledger", async () => {
    const file = makeBinaryFile("archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const result = await detectImportTarget(file);
    expect(result?.target).toBe("ledger");
    expect(result?.bytes).toBeDefined();
  });
});
