// @ts-nocheck — Node.js modules (fs, path, url) not in browser tsconfig
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// These tests use real sample PDFs from tmp/Nuri (ex Bitwala)/
// They are skipped if the files are not present (CI environments)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLES_DIR = resolve(__dirname, "../../../../tmp/Nuri (ex Bitwala)");

function loadSample(filename: string): Uint8Array | null {
  const path = resolve(SAMPLES_DIR, filename);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

async function parseFromFile(data: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const { groupByY } = await import("../extract-text.js");
  const { parseNuriStatement } = await import("./nuri.js");

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

  return parseNuriStatement(pages);
}

const sample2020_10 = loadSample("2020-10 Bitwala statement.pdf");
const sample2021_01 = loadSample("2021-01 Bitwala statement.pdf");
const sample2021_05 = loadSample("2021-05 Nuri statement.pdf");
const sample2022_11 = loadSample("2022-11 Nuri statement.pdf");

describe("Nuri/Bitwala integration tests", () => {
  it.skipIf(!sample2020_10)("2020-10 Bitwala: empty statement with balance", async () => {
    const result = await parseFromFile(sample2020_10!);

    expect(result.transactions).toHaveLength(0);
    expect(result.openingDate).toBe("2020-10-01");
    expect(result.closingDate).toBe("2020-10-31");
    expect(result.openingBalance).toBe(28);
    expect(result.closingBalance).toBe(28);
    expect(result.iban).toBeTruthy();
    expect(result.iban!).toMatch(/^DE/);
    expect(result.currency).toBe("EUR");
  });

  it.skipIf(!sample2021_01)("2021-01 Bitwala: parses 5 transactions", async () => {
    const result = await parseFromFile(sample2021_01!);

    expect(result.transactions).toHaveLength(5);
    expect(result.openingDate).toBe("2021-01-01");
    expect(result.closingDate).toBe("2021-01-31");
    expect(result.openingBalance).toBe(0);
    expect(result.closingBalance).toBe(0);

    // All dates should be in January 2021
    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2021-01-/);
      expect(tx.amount).not.toBe(0);
    }

    // Check specific transactions
    const incoming = result.transactions.filter((tx) => tx.amount > 0);
    const outgoing = result.transactions.filter((tx) => tx.amount < 0);
    expect(incoming).toHaveLength(3);
    expect(outgoing).toHaveLength(2);

    // First tx: 224.00 from MAX MUSTERMANN
    expect(result.transactions[0].amount).toBe(224);
    expect(result.transactions[0].description).toContain("MAX MUSTERMANN");

    // Outgoing: -48.00 and -1000.00
    expect(outgoing.map((tx) => tx.amount).sort((a, b) => a - b)).toEqual([-1000, -48]);
  });

  it.skipIf(!sample2021_05)("2021-05 Nuri: parses 2 transactions", async () => {
    const result = await parseFromFile(sample2021_05!);

    expect(result.transactions).toHaveLength(2);
    expect(result.openingDate).toBe("2021-05-01");
    expect(result.closingDate).toBe("2021-05-31");
    expect(result.openingBalance).toBe(40);
    expect(result.closingBalance).toBe(0);

    // Incoming 460.00 and outgoing -500.00
    expect(result.transactions[0].amount).toBe(460);
    expect(result.transactions[1].amount).toBe(-500);

    for (const tx of result.transactions) {
      expect(tx.date).toMatch(/^2021-05-/);
    }
  });

  it.skipIf(!sample2022_11)("2022-11 Nuri: empty statement (new column layout)", async () => {
    const result = await parseFromFile(sample2022_11!);

    expect(result.transactions).toHaveLength(0);
    expect(result.openingDate).toBe("2022-11-01");
    expect(result.closingDate).toBe("2022-11-30");
    expect(result.openingBalance).toBe(0);
    expect(result.closingBalance).toBe(0);
    expect(result.iban).toBeTruthy();
    expect(result.currency).toBe("EUR");
  });
});
