import type { PdfPage, PdfStatement, PdfTextItem, PdfTextLine, PdfTransaction } from "../types.js";

/** Match DD/MM at start of text */
const DATE_RE = /^(\d{2})\/(\d{2})$/;

/** Match "Ancien solde au DD/MM/YYYY" */
const OPENING_BALANCE_RE = /Ancien solde au (\d{2})\/(\d{2})\/(\d{4})/;

/** Match "Nouveau solde au DD/MM/YYYY" */
const CLOSING_BALANCE_RE = /Nouveau solde au (\d{2})\/(\d{2})\/(\d{4})/;

/** Match "Total des opérations" */
const TOTAL_RE = /Total des op/;

/** Match account number: CCP n° or Compte Courant Postal n° */
const ACCOUNT_RE = /(?:CCP|Compte Courant Postal)\s+n°\s*([\d\s\w]+)/;

/** Match IBAN — capture all alphanumeric + spaces up to pipe or end */
const IBAN_RE = /IBAN\s*:\s*([A-Z]{2}\d{2}[\dA-Z\s]+?)(?:\s*\||$)/;

/** X-coordinate tolerance for classifying amounts into debit/credit columns */
const X_COL_TOLERANCE = 30;

interface ColumnPositions {
  debitX: number;
  creditX: number;
}

/** Intermediate transaction with unresolved year */
interface RawTx {
  day: number;
  month: number;
  descParts: string[];
  amount: number | null;
}

/**
 * Parse a La Banque Postale PDF statement into structured data.
 */
export function parseLbpStatement(pages: PdfPage[]): PdfStatement {
  const warnings: string[] = [];

  if (pages.length === 0) {
    warnings.push("No pages found in PDF");
    return makeEmptyStatement(warnings);
  }

  // Extract account info from all pages
  const accountNumber = extractAccountNumber(pages);
  const iban = extractIban(pages);

  // First pass: scan all lines to find opening/closing dates and collect raw transactions
  let columns: ColumnPositions | null = null;
  let inTable = false;
  let openingBalance: number | null = null;
  let openingDate: string | null = null;
  let closingBalance: number | null = null;
  let closingDate: string | null = null;
  let openingYear: number | null = null;
  let closingYear: number | null = null;

  const rawTxs: RawTx[] = [];
  let currentTx: RawTx | null = null;

  function finalizeTx() {
    if (!currentTx || currentTx.amount === null) {
      currentTx = null;
      return;
    }
    rawTxs.push(currentTx);
    currentTx = null;
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");

      // Detect table header
      if (!inTable || isContinuationHeader(lineText)) {
        const detected = detectColumns(line);
        if (detected) {
          // Finalize any pending transaction before new header
          finalizeTx();
          columns = detected;
          inTable = true;
          continue;
        }
      }

      if (!inTable || !columns) continue;

      // Check for sentinel lines
      const openMatch = lineText.match(OPENING_BALANCE_RE);
      if (openMatch) {
        finalizeTx();
        openingYear = parseInt(openMatch[3], 10);
        openingDate = `${openMatch[3]}-${openMatch[2]}-${openMatch[1]}`;
        const amt = findAmountOnLine(line, columns);
        if (amt !== null) {
          openingBalance = amt;
        }
        continue;
      }

      const closeMatch = lineText.match(CLOSING_BALANCE_RE);
      if (closeMatch) {
        finalizeTx();
        closingYear = parseInt(closeMatch[3], 10);
        closingDate = `${closeMatch[3]}-${closeMatch[2]}-${closeMatch[1]}`;
        const amt = findAmountOnLine(line, columns);
        if (amt !== null) {
          closingBalance = amt;
        }
        continue;
      }

      if (TOTAL_RE.test(lineText)) {
        finalizeTx();
        continue;
      }

      // Skip "(suite)" continuation header text lines
      if (lineText.includes("(suite)")) {
        continue;
      }

      // Check if this is a date line (new transaction)
      const firstItem = line.items[0];
      const dateMatch = firstItem?.str.match(DATE_RE);
      if (dateMatch) {
        finalizeTx();

        const day = parseInt(dateMatch[1], 10);
        const month = parseInt(dateMatch[2], 10);

        // Extract description (items after date, before amount columns)
        const descItems = line.items.filter((it) => {
          if (it === firstItem) return false;
          if (isNearColumn(it.x, columns!)) return false;
          // Exclude items in the "Soit en francs" column (beyond credit column)
          if (it.x > columns!.creditX + X_COL_TOLERANCE) return false;
          return true;
        });
        const desc = descItems.map((it) => it.str).join(" ").trim();

        const amount = findAmountOnLine(line, columns);

        currentTx = {
          day,
          month,
          descParts: desc ? [desc] : [],
          amount,
        };
        continue;
      }

      // Continuation line (no date at start)
      if (currentTx) {
        const descItems = line.items.filter((it) =>
          !isNearColumn(it.x, columns!) && it.x <= columns!.creditX + X_COL_TOLERANCE
        );
        const text = descItems.map((it) => it.str).join(" ").trim();
        if (text) {
          // Skip "Soit en francs" values (numeric-only lines in far-right column)
          if (/^[+\-]?\s*[\d\s,.]+$/.test(text) && isFrancsColumn(line, columns)) continue;
          if (/^Page\s/.test(text)) continue;
          currentTx.descParts.push(text);
        }

        // A continuation line might carry the amount if the date line didn't have one
        if (currentTx.amount === null) {
          const amt = findAmountOnLine(line, columns);
          if (amt !== null) {
            currentTx.amount = amt;
          }
        }
      }
    }
  }

  // Finalize last transaction
  finalizeTx();

  // Second pass: resolve years now that we have both opening and closing dates
  const transactions: PdfTransaction[] = rawTxs.map((raw, idx) => {
    const year = resolveYear(raw.month, openingYear, closingYear, openingDate, closingDate);
    const mm = String(raw.month).padStart(2, "0");
    const dd = String(raw.day).padStart(2, "0");
    const { description, metadata } = extractLbpMetadata(raw.descParts.join(" "));
    return {
      date: `${year}-${mm}-${dd}`,
      description,
      amount: raw.amount!,
      index: idx,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });

  if (transactions.length === 0 && !inTable) {
    warnings.push("No transaction table found in PDF");
  }

  return {
    accountNumber,
    iban,
    currency: "EUR",
    openingBalance,
    openingDate,
    closingBalance,
    closingDate,
    transactions,
    warnings,
  };
}

/**
 * Detect "Débit" and "Crédit" column header positions from a table header line.
 */
export function detectColumns(line: PdfTextLine): ColumnPositions | null {
  let debitX: number | null = null;
  let creditX: number | null = null;
  let hasDate = false;

  for (const item of line.items) {
    const text = item.str.trim();
    if (text === "Date") hasDate = true;
    if (/^D[ée]bit/.test(text)) debitX = item.x;
    if (/^Cr[ée]dit/.test(text)) creditX = item.x;
  }

  if (debitX !== null && creditX !== null && hasDate) {
    return { debitX, creditX };
  }
  return null;
}

/**
 * Check if a line is a continuation header (page 2+ table header with "suite").
 */
function isContinuationHeader(lineText: string): boolean {
  return lineText.includes("Date") && lineText.includes("bit");
}

/**
 * Find an amount value on a line by checking items near debit/credit column positions.
 * Returns negative for debit, positive for credit.
 */
function findAmountOnLine(line: PdfTextLine, columns: ColumnPositions): number | null {
  let debitAmt: number | null = null;
  let creditAmt: number | null = null;

  for (const item of line.items) {
    const text = item.str.trim();
    if (!text || !/[\d,.]/.test(text)) continue;

    const debitDist = Math.abs(item.x - columns.debitX);
    const creditDist = Math.abs(item.x - columns.creditX);

    if (debitDist < X_COL_TOLERANCE && debitDist < creditDist) {
      const parsed = parseLbpAmount(text);
      if (parsed !== null) debitAmt = parsed;
    } else if (creditDist < X_COL_TOLERANCE) {
      const parsed = parseLbpAmount(text);
      if (parsed !== null) creditAmt = parsed;
    }
  }

  // Debit = money out = negative, Credit = money in = positive
  if (debitAmt !== null) return -debitAmt;
  if (creditAmt !== null) return creditAmt;
  return null;
}

/**
 * Check if an X coordinate is near a column header position.
 */
function isNearColumn(x: number, columns: ColumnPositions): boolean {
  return Math.abs(x - columns.debitX) < X_COL_TOLERANCE ||
         Math.abs(x - columns.creditX) < X_COL_TOLERANCE;
}

/**
 * Check if a line has items in the "Soit en francs" column area (2012 format).
 */
function isFrancsColumn(line: PdfTextLine, columns: ColumnPositions): boolean {
  return line.items.some((it) => it.x > columns.creditX + X_COL_TOLERANCE);
}

/**
 * Parse LBP amount format: "1 203,55" (space=thousands, comma=decimal).
 */
export function parseLbpAmount(raw: string): number | null {
  let normalized = raw.replace(/[\s\u00A0]/g, "");
  normalized = normalized.replace(",", ".");
  normalized = normalized.replace(/[^\d.\-]/g, "");
  if (!normalized) return null;
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

/**
 * Resolve year for a DD/MM transaction date.
 * Uses opening and closing balance dates to determine the correct year.
 * Handles year boundary (December → January).
 */
export function resolveYear(
  txMonth: number,
  openingYear: number | null,
  closingYear: number | null,
  openingDate: string | null,
  closingDate: string | null,
): number {
  if (openingYear !== null && closingYear !== null) {
    if (openingYear === closingYear) return openingYear;
    // Year boundary: opening in year X, closing in year X+1
    if (txMonth >= 10) return openingYear;
    return closingYear;
  }

  if (closingYear !== null) return closingYear;
  if (openingYear !== null) return openingYear;

  return new Date().getFullYear();
}

function extractAccountNumber(pages: PdfPage[]): string | null {
  for (const page of pages) {
    for (const line of page.lines) {
      const text = line.items.map((it) => it.str).join(" ");
      const match = text.match(ACCOUNT_RE);
      if (match) {
        return match[1].replace(/\s+/g, " ").trim();
      }
    }
  }
  return null;
}

function extractIban(pages: PdfPage[]): string | null {
  for (const page of pages) {
    for (const line of page.lines) {
      // Join with spaces to preserve the full IBAN text
      const text = line.items.map((it) => it.str).join(" ");
      const match = text.match(IBAN_RE);
      if (match) {
        // Remove all spaces from matched IBAN
        return match[1].replace(/\s+/g, "").trim();
      }
    }
  }
  return null;
}

// ─── Metadata extraction ────────────────────────────────────────────────────

interface LbpKeyword {
  pattern: RegExp;
  type: string;
}

/**
 * Keyword table for LBP transaction types. Order matters:
 * - REMISE CHEQUE before CHEQUE
 * - VIREMENT EN FAVEUR DE / VIREMENT POUR before VIREMENT DE
 */
const LBP_TX_TYPE_KEYWORDS: LbpKeyword[] = [
  { pattern: /^REMISE CHEQUE\s*/i, type: "check-deposit" },
  { pattern: /^ACHAT CB\s*/i, type: "card-purchase" },
  { pattern: /^RETRAIT DAB\s*/i, type: "atm-withdrawal" },
  { pattern: /^VIREMENT EN FAVEUR DE\s*/i, type: "transfer-out" },
  { pattern: /^VIREMENT POUR\s*/i, type: "transfer-out" },
  { pattern: /^VIREMENT DE\s*/i, type: "transfer-in" },
  { pattern: /^PRELEVEMENT DE\s*/i, type: "direct-debit" },
  { pattern: /^CHEQUE N[°\s]/i, type: "check" },
  { pattern: /^INTERETS ACQUIS\s*/i, type: "interest" },
  { pattern: /^AVOIR\s*/i, type: "refund" },
  { pattern: /^COTISATION\s*/i, type: "fee" },
  { pattern: /^COMMISSION\s*/i, type: "fee" },
  { pattern: /^FRAIS\s*/i, type: "fee" },
];

/** Extract card number: CARTE NUMERO 999 or CB*1234 */
const CARD_NUMBER_RE = /CARTE\s+NUMERO\s+(\d+)/i;
const CB_STAR_RE = /CB\*(\d{4})/i;

/** Extract operation date: DD.MM.YY or DD/MM or DD.MM */
const OP_DATE_RE = /(\d{2})[./](\d{2})[./]?(\d{2,4})?/;

/** Extract reference and mandate */
const REF_RE = /REF(?:ERENCE)?\s*:\s*(\S+)/i;
const MANDATE_RE = /MAND(?:AT)?\s*:?\s*(\S+)/i;

/** Extract check number */
const CHECK_NUM_RE = /N[°\s]+(\d+)/i;

/**
 * Extract structured metadata from an LBP transaction description.
 * Strips keywords, card numbers, dates, references — returns clean description + metadata.
 */
export function extractLbpMetadata(rawDesc: string): { description: string; metadata: Record<string, string> } {
  const metadata: Record<string, string> = {};
  let text = rawDesc;

  // Step 1 — Match transaction type keyword
  for (const kw of LBP_TX_TYPE_KEYWORDS) {
    const kwMatch = text.match(kw.pattern);
    if (kwMatch) {
      metadata["transaction-type"] = kw.type;
      text = text.slice(kwMatch[0].length);
      break;
    }
  }

  // Step 2 — Extract card number
  const cardMatch = text.match(CARD_NUMBER_RE);
  if (cardMatch) {
    metadata["card-number"] = cardMatch[1];
    text = text.replace(cardMatch[0], " ");
  } else {
    const cbMatch = text.match(CB_STAR_RE);
    if (cbMatch) {
      metadata["card-number"] = cbMatch[1];
      text = text.replace(cbMatch[0], " ");
    }
  }

  // Step 3 — Extract operation date (DD.MM.YY or DD/MM)
  const dateMatch = text.match(OP_DATE_RE);
  if (dateMatch) {
    metadata["operation-date"] = `${dateMatch[1]}/${dateMatch[2]}`;
    text = text.replace(dateMatch[0], " ");
  }

  // Step 4 — Extract references
  const refMatch = text.match(REF_RE);
  if (refMatch) {
    metadata["reference"] = refMatch[1];
    text = text.replace(refMatch[0], " ");
  }

  const mandateMatch = text.match(MANDATE_RE);
  if (mandateMatch) {
    metadata["mandate"] = mandateMatch[1];
    text = text.replace(mandateMatch[0], " ");
  }

  // Step 5 — Extract check number (for CHEQUE type)
  // After keyword strip, remaining text may be "° 2676038" or just "2676038"
  if (metadata["transaction-type"] === "check") {
    const checkMatch = text.match(/°?\s*(\d+)/);
    if (checkMatch) {
      metadata["check-number"] = checkMatch[1];
      text = text.replace(checkMatch[0], " ");
    }
  }

  // Step 6 — Normalize whitespace, trim
  let description = text.replace(/\s+/g, " ").trim();

  // If empty after stripping, keep original
  if (!description) {
    description = rawDesc;
  }

  return { description, metadata };
}

function makeEmptyStatement(warnings: string[]): PdfStatement {
  return {
    accountNumber: null,
    iban: null,
    currency: "EUR",
    openingBalance: null,
    openingDate: null,
    closingBalance: null,
    closingDate: null,
    transactions: [],
    warnings,
  };
}
