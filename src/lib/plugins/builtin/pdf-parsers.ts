import type { PdfParserExtension } from "../types.js";
import type { PdfPage, PdfStatement } from "../../pdf/types.js";
import { parseN26Statement } from "../../pdf/parsers/n26.js";
import { parseLbpStatement } from "../../pdf/parsers/la-banque-postale.js";
import { parseNuriStatement } from "../../pdf/parsers/nuri.js";
import { parseDeblockStatement } from "../../pdf/parsers/deblock.js";
import { suggestMainAccount } from "../../pdf/convert.js";

function detectByTransactionCount(parseFn: (pages: PdfPage[]) => PdfStatement): (pages: PdfPage[]) => number {
  return (pages: PdfPage[]) => {
    try {
      const result = parseFn(pages);
      if (result.transactions.length === 0) return 0;
      // More transactions = higher confidence, capped at 90
      return Math.min(50 + result.transactions.length * 5, 90);
    } catch {
      return 0;
    }
  };
}

export const n26PdfParser: PdfParserExtension = {
  id: "pdf-n26",
  name: "N26 Bank Statement",
  presetId: "pdf-n26",
  detect: detectByTransactionCount(parseN26Statement),
  parse: parseN26Statement,
  suggestAccount: (statement) => suggestMainAccount(statement, "n26"),
};

export const lbpPdfParser: PdfParserExtension = {
  id: "pdf-lbp",
  name: "La Banque Postale Statement",
  presetId: "pdf-lbp",
  detect: detectByTransactionCount(parseLbpStatement),
  parse: parseLbpStatement,
  suggestAccount: (statement) => suggestMainAccount(statement, "lbp"),
};

export const nuriPdfParser: PdfParserExtension = {
  id: "pdf-nuri",
  name: "Nuri/Bitwala Statement",
  presetId: "pdf-nuri",
  detect: detectByTransactionCount(parseNuriStatement),
  parse: parseNuriStatement,
  suggestAccount: (statement) => suggestMainAccount(statement, "nuri"),
};

export const deblockPdfParser: PdfParserExtension = {
  id: "pdf-deblock",
  name: "Deblock Statement",
  presetId: "pdf-deblock",
  detect: detectByTransactionCount(parseDeblockStatement),
  parse: parseDeblockStatement,
  suggestAccount: (statement) => suggestMainAccount(statement, "deblock"),
};

export const builtinPdfParsers: PdfParserExtension[] = [
  n26PdfParser,
  lbpPdfParser,
  nuriPdfParser,
  deblockPdfParser,
];
