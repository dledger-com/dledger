import type { PdfPage, PdfTextItem, PdfTextLine } from "./types.js";

/** Y-coordinate tolerance for grouping items on the same line (in PDF points). */
const Y_TOLERANCE = 2;

/**
 * Extract structured text with coordinates from a PDF file.
 * Groups text items into lines by Y coordinate, sorts top-to-bottom / left-to-right.
 */
export async function extractPdfPages(data: Uint8Array): Promise<PdfPage[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const doc = await pdfjsLib.getDocument({ data }).promise;
  const pages: PdfPage[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Collect text items with coordinates
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

    // Group items into lines by Y coordinate
    const lines = groupByY(items);
    pages.push({ pageNumber: i, lines });
  }

  return pages;
}

/**
 * Group text items into lines using Y-coordinate proximity.
 * Items within Y_TOLERANCE of each other are placed on the same line.
 * Lines are sorted top-to-bottom (descending Y), items left-to-right (ascending X).
 */
export function groupByY(items: PdfTextItem[]): PdfTextLine[] {
  if (items.length === 0) return [];

  // Sort items by Y descending (top of page = high Y values)
  const sorted = [...items].sort((a, b) => b.y - a.y);

  const lines: PdfTextLine[] = [];
  let currentLine: PdfTextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    // Compare against any item in the current line (not just the first)
    const fitsLine = currentLine.some((ci) => Math.abs(item.y - ci.y) <= Y_TOLERANCE);
    if (fitsLine) {
      currentLine.push(item);
    } else {
      // Finalize current line
      currentLine.sort((a, b) => a.x - b.x);
      lines.push({ y: currentY, items: currentLine });
      currentLine = [item];
      currentY = item.y;
    }
  }

  // Don't forget the last line
  currentLine.sort((a, b) => a.x - b.x);
  lines.push({ y: currentY, items: currentLine });

  return lines;
}
