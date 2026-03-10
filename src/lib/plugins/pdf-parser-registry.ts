import type { PdfParserExtension } from "./types.js";
import type { PdfPage, PdfStatement } from "../pdf/types.js";

export interface PdfParserDetectionResult {
  parser: PdfParserExtension;
  confidence: number;
}

export class PdfParserRegistry {
  private parsers: PdfParserExtension[] = [];

  register(parser: PdfParserExtension): void {
    this.parsers.push(parser);
  }

  getAll(): PdfParserExtension[] {
    return [...this.parsers];
  }

  getById(id: string): PdfParserExtension | undefined {
    return this.parsers.find((p) => p.id === id);
  }

  /**
   * Detect the best parser for the given PDF pages.
   * Runs detect() on all parsers and returns the one with highest confidence.
   */
  detectBest(pages: PdfPage[]): PdfParserDetectionResult | null {
    let best: PdfParserDetectionResult | null = null;
    for (const parser of this.parsers) {
      const confidence = parser.detect(pages);
      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = { parser, confidence };
      }
    }
    return best;
  }

  /**
   * Detect all parsers that can handle these pages, sorted by confidence.
   */
  detectAll(pages: PdfPage[]): PdfParserDetectionResult[] {
    const results: PdfParserDetectionResult[] = [];
    for (const parser of this.parsers) {
      const confidence = parser.detect(pages);
      if (confidence > 0) {
        results.push({ parser, confidence });
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }
}
