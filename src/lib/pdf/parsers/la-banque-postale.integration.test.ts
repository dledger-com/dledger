// @ts-nocheck — Node.js modules (fs, path, url) not in browser tsconfig
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// These tests use real sample PDFs from tmp/LBP/
// They are skipped if the files are not present (CI environments)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLES_DIR = resolve(__dirname, "../../../../tmp/LBP");

function loadSample(filename: string): Uint8Array | null {
  const path = resolve(SAMPLES_DIR, filename);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

// Parse a PDF file using the legacy build (Node.js compatible)
async function parseFromFile(data: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const { groupByY } = await import("../extract-text.js");
  const { parseLbpStatement } = await import("./la-banque-postale.js");

  type PdfTextItem = import("../types.js").PdfTextItem;
  type PdfPageType = import("../types.js").PdfPage;

  const pages: PdfPageType[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const transform = item.transform as number[];
      items.push({
        str: item.str,
        x: transform[4],
        y: transform[5],
        width: item.width,
        height: item.height,
        fontName: item.fontName ?? "",
      });
    }
    const lines = groupByY(items);
    pages.push({ pageNumber: i, lines });
  }

  return parseLbpStatement(pages);
}

const sample2022Feb = loadSample("2022-02-28 La Banque Postale statement.pdf");
const sample2022Mar = loadSample("2022-03-28 La Banque Postale statement.pdf");
const sample2012CCP = loadSample("releve_CCP1234567X020_20120926.pdf");
const sample2012LA = loadSample("releve_LA0000000000X_20121126.pdf");

describe("La Banque Postale integration tests", () => {
  it.skipIf(!sample2022Feb)("2022-02-28: parses transactions, balance, and account info", async () => {
    const result = await parseFromFile(sample2022Feb!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2022-01-26");
    expect(result.closingDate).toBe("2022-02-25");
    expect(result.openingBalance).toBe(522.92);
    expect(result.closingBalance).toBe(631.6);

    const first = result.transactions[0];
    expect(first.date).toBe("2022-01-31");
    expect(first.description).toContain("TOLLOPERATOR");

    const last = result.transactions[result.transactions.length - 1];
    expect(last.date).toContain("2022-02");

    // Account info
    expect(result.accountNumber).toContain("12 345 67");
    expect(result.iban).toContain("FR07");
    expect(result.currency).toBe("EUR");
  });

  it.skipIf(!sample2022Mar)("2022-03-28: parses transactions", async () => {
    const result = await parseFromFile(sample2022Mar!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2022-02-25");
    expect(result.closingDate).toBe("2022-03-25");
    expect(result.openingBalance).toBe(631.6);
    expect(result.closingBalance).toBe(328.05);
  });

  it.skipIf(!sample2012CCP)("2012 CCP: parses with Soit en francs column", async () => {
    const result = await parseFromFile(sample2012CCP!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2012-08-24");
    expect(result.closingDate).toBe("2012-09-26");
    expect(result.openingBalance).toBe(445.75);
    expect(result.closingBalance).toBe(344.44);

    const first = result.transactions[0];
    expect(first.date).toContain("2012");
  });

  it.skipIf(!sample2012LA)("2012 Livret A: parses multi-page statement", async () => {
    const result = await parseFromFile(sample2012LA!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2012-10-26");
    expect(result.closingDate).toBe("2012-11-26");
  });
});
