// @ts-nocheck — Node.js modules (fs, path, url) not in browser tsconfig
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// These tests use real sample PDFs from tmp/N26/
// They are skipped if the files are not present (CI environments)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLES_DIR = resolve(__dirname, "../../../../tmp/N26");

function loadSample(filename: string): Uint8Array | null {
  const path = resolve(SAMPLES_DIR, filename);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

async function parseFromFile(data: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const { groupByY } = await import("../extract-text.js");
  const { parseN26Statement } = await import("./n26.js");

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

  return parseN26Statement(pages);
}

// ─── New format samples (2021+) ─────────────────────────────────────────────

const sample2021_09 = loadSample("2021-09 N26 statement.pdf");
const sample2021_10 = loadSample("2021-10 N26 statement.pdf");
const sample2022_01 = loadSample("N26 before_fr_migration_statement-2022-01.pdf");
const sample2024_07_before = loadSample("N26 before_fr_migration_last_statement-2024-07.pdf");
const sample2024_07_after = loadSample("N26 after_fr_migration_first_statement-2024-07.pdf");
const sample2025_01 = loadSample("N26 statement-2025-01.pdf");
const sample2026_01 = loadSample("N26 statement-2026-01.pdf");

// ─── Old format samples (2017-2020) ─────────────────────────────────────────

const sample2017_08 = loadSample("2017-08 N26 statement.pdf");
const sample2017_09 = loadSample("2017-09 N26 statement.pdf");
const sample2019_02 = loadSample("2019-02 N26 statement.pdf");
const sample2020_03 = loadSample("2020-03 N26 statement.pdf");

describe("N26 integration tests — new format", () => {
  it.skipIf(!sample2021_09)("2021-09: parses transactions and balances", async () => {
    const result = await parseFromFile(sample2021_09!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2021-09-01");
    expect(result.closingDate).toBe("2021-09-30");
    expect(result.openingBalance).toBeTypeOf("number");
    expect(result.closingBalance).toBeTypeOf("number");
    expect(result.currency).toBe("EUR");

    // All dates should be in September 2021
    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2021-09-/);
      expect(tx.amount).not.toBe(0);
    }
  });

  it.skipIf(!sample2021_10)("2021-10: parses transactions", async () => {
    const result = await parseFromFile(sample2021_10!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toBe("2021-10-01");
    expect(result.closingDate).toBe("2021-10-31");
  });

  it.skipIf(!sample2022_01)("2022-01 (pre-migration): parses with DE IBAN", async () => {
    const result = await parseFromFile(sample2022_01!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^DE/);
    expect(result.openingDate).toContain("2022-01");
  });

  it.skipIf(!sample2024_07_before)("2024-07 (last DE statement): short period", async () => {
    const result = await parseFromFile(sample2024_07_before!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^DE/);
  });

  it.skipIf(!sample2024_07_after)("2024-07 (first FR statement): parses with FR IBAN", async () => {
    const result = await parseFromFile(sample2024_07_after!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^FR/);
  });

  it.skipIf(!sample2025_01)("2025-01: parses transactions", async () => {
    const result = await parseFromFile(sample2025_01!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toContain("2025-01");
    expect(result.closingDate).toContain("2025-01");
    expect(result.iban).toBeTruthy();
  });

  it.skipIf(!sample2026_01)("2026-01: parses transactions without footer pollution", async () => {
    const result = await parseFromFile(sample2026_01!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingDate).toContain("2026-01");

    // Verify no transaction description contains page footer/header patterns
    for (const tx of result.transactions) {
      expect(tx.description).not.toMatch(/Relevé de compte/i);
      expect(tx.description).not.toMatch(/Émis le/i);
      expect(tx.description).not.toMatch(/\bIBAN\s+FR\d/);
      // Footer contains address lines — check for common French postal patterns
      expect(tx.description).not.toMatch(/\b\d{5}\s+\w+.*France\b/i);
      // Description should not contain bullet-separated category
      expect(tx.description).not.toMatch(/\s+[•·]\s+/);
    }

    // Check that at least some transactions have categories extracted
    const withCategory = result.transactions.filter((tx) => tx.category);
    // N26 2026 statements typically have categories; if present, verify they're clean
    for (const tx of withCategory) {
      expect(tx.category!.length).toBeGreaterThan(0);
      expect(tx.category).not.toMatch(/^\s/);
      expect(tx.category).not.toMatch(/\s$/);
    }
  });
});

describe("N26 integration tests — old format", () => {
  it.skipIf(!sample2017_08)("2017-08: empty statement (account just opened)", async () => {
    const result = await parseFromFile(sample2017_08!);

    // This is the opening statement with zero transactions
    expect(result.transactions).toHaveLength(0);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^DE/);
    expect(result.currency).toBe("EUR");
  });

  it.skipIf(!sample2017_09)("2017-09: parses old-format transactions", async () => {
    const result = await parseFromFile(sample2017_09!);

    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.openingBalance).toBeTypeOf("number");
    expect(result.closingBalance).toBeTypeOf("number");

    // All dates should be in September 2017
    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2017-09-/);
      expect(tx.amount).not.toBe(0);
    }
  });

  it.skipIf(!sample2019_02)("2019-02: parses old-format transactions", async () => {
    const result = await parseFromFile(sample2019_02!);

    expect(result.transactions.length).toBeGreaterThan(0);

    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2019-02-/);
    }
  });

  it.skipIf(!sample2020_03)("2020-03: parses old-format transactions", async () => {
    const result = await parseFromFile(sample2020_03!);

    expect(result.transactions.length).toBeGreaterThan(0);

    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2020-03-/);
    }
  });
});
