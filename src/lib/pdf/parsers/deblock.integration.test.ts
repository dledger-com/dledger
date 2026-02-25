// @ts-nocheck — Node.js modules (fs, path, url) not in browser tsconfig
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// These tests use real sample PDFs from tmp/Deblock/
// They are skipped if the files are not present (CI environments)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLES_DIR = resolve(__dirname, "../../../../tmp/Deblock");

function loadSample(filename: string): Uint8Array | null {
  const path = resolve(SAMPLES_DIR, filename);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

async function parseFromFile(data: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const { groupByY } = await import("../extract-text.js");
  const { parseDeblockStatement } = await import("./deblock.js");

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

  return parseDeblockStatement(pages);
}

// March 2025 — 1 page, 10 transactions
const sampleMar2025 = loadSample("statement_00000000-0000-0000-0000-000000000001.pdf");

// July 2025 — 3 pages, 62 transactions (with Achat Crypto multi-line)
const sampleJul2025 = loadSample("statement_00000000-0000-0000-0000-000000000002.pdf");

// October 2025 — 1 page, 18 transactions (with Prélèvement automatique multi-line)
const sampleOct2025 = loadSample("statement_00000000-0000-0000-0000-000000000003.pdf");

// November 2025 — 3 pages, 56 transactions
const sampleNov2025 = loadSample("statement_00000000-0000-0000-0000-000000000004.pdf");

// October 2024 — empty statement
const sampleOct2024Empty = loadSample("statement_00000000-0000-0000-0000-000000000005.pdf");

// August 2024 — empty statement
const sampleAug2024Empty = loadSample("statement_00000000-0000-0000-0000-000000000006.pdf");

describe("Deblock integration tests", () => {
  it.skipIf(!sampleMar2025)("March 2025: 9 transactions, single page", async () => {
    const result = await parseFromFile(sampleMar2025!);

    expect(result.transactions).toHaveLength(9);
    expect(result.openingDate).toBe("2025-03-01");
    expect(result.closingDate).toBe("2025-04-01");
    expect(result.closingBalance).toBe(26.8);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^FR/);
    expect(result.currency).toBe("EUR");

    // All dates should be in March 2025
    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2025-03-/);
      expect(tx.amount).not.toBe(0);
    }

    // Check mix of debits and credits
    const debits = result.transactions.filter((tx) => tx.amount < 0);
    const credits = result.transactions.filter((tx) => tx.amount > 0);
    expect(debits.length).toBeGreaterThan(0);
    expect(credits.length).toBeGreaterThan(0);
  });

  it.skipIf(!sampleJul2025)("July 2025: 83 transactions, 3 pages with Achat Crypto", async () => {
    const result = await parseFromFile(sampleJul2025!);

    expect(result.transactions).toHaveLength(83);
    expect(result.openingDate).toBe("2025-07-01");
    expect(result.closingDate).toBe("2025-08-01");
    expect(result.closingBalance).toBe(1641.61);
    expect(result.iban).toBeTruthy();
    expect(result.currency).toBe("EUR");

    // All dates should be in July 2025
    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2025-07-/);
    }

    // Should have some Achat Crypto entries
    const cryptoTxs = result.transactions.filter((tx) => tx.description.includes("Achat Crypto"));
    expect(cryptoTxs.length).toBeGreaterThan(0);
    // Achat Crypto is a debit
    for (const tx of cryptoTxs) {
      expect(tx.amount).toBeLessThan(0);
    }
  });

  it.skipIf(!sampleOct2025)("October 2025: 17 transactions with Prélèvement automatique", async () => {
    const result = await parseFromFile(sampleOct2025!);

    expect(result.transactions).toHaveLength(17);
    expect(result.openingDate).toBe("2025-10-01");
    expect(result.closingDate).toBe("2025-11-01");
    expect(result.closingBalance).toBe(4794.77);
    expect(result.currency).toBe("EUR");

    // Should contain the Prélèvement automatique transaction
    const prelevements = result.transactions.filter((tx) =>
      tx.description.includes("Prélèvement automatique"),
    );
    expect(prelevements.length).toBeGreaterThan(0);
  });

  it.skipIf(!sampleNov2025)("November 2025: 75 transactions, 3 pages", async () => {
    const result = await parseFromFile(sampleNov2025!);

    expect(result.transactions).toHaveLength(75);
    expect(result.openingDate).toBe("2025-11-01");
    expect(result.closingDate).toBe("2025-12-01");
    expect(result.closingBalance).toBe(5932.56);
    expect(result.iban).toBeTruthy();
    expect(result.currency).toBe("EUR");
  });

  it.skipIf(!sampleOct2024Empty)("October 2024: empty statement", async () => {
    const result = await parseFromFile(sampleOct2024Empty!);

    expect(result.transactions).toHaveLength(0);
    expect(result.openingDate).toBe("2024-10-01");
    expect(result.closingDate).toBe("2024-11-01");
    expect(result.closingBalance).toBeNull(); // empty statements have no balance amount
    expect(result.iban).toBeTruthy();
    expect(result.currency).toBe("EUR");
  });

  it.skipIf(!sampleAug2024Empty)("August 2024: empty statement", async () => {
    const result = await parseFromFile(sampleAug2024Empty!);

    expect(result.transactions).toHaveLength(0);
    expect(result.openingDate).toBe("2024-08-01");
    expect(result.closingDate).toBe("2024-09-01");
    expect(result.closingBalance).toBeNull();
    expect(result.iban).toBeTruthy();
    expect(result.currency).toBe("EUR");
  });
});
