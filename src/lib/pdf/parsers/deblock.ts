import type { PdfPage, PdfStatement, PdfTextLine, PdfTransaction } from "../types.js";

/** French month names → 1-based index */
const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12,
  // Variants without accents (pdf text extraction sometimes strips them)
  fevrier: 2, aout: 8, decembre: 12,
};

/** Match French date: "6 mars 2025", "19 juillet 2025", "1 novembre 2024" */
const FRENCH_DATE_RE = /^(\d{1,2})\s+([\wéèûàô]+)\s+(\d{4})$/;

/** Match period line: "Transactions du compte du ... au ..." */
const PERIOD_RE = /Transactions du compte du (\d{1,2}\s+[\wéèûàô]+\s+\d{4}) au (\d{1,2}\s+[\wéèûàô]+\s+\d{4})/;

/** Match closing balance: "Solde créditeur au ..." or "Solde crediteur au ..." */
const CLOSING_BALANCE_RE = /Solde cr[ée]diteur au (\d{1,2}\s+[\wéèûàô]+\s+\d{4})/;

/** IBAN line regex — match "FR..." format */
const IBAN_RE = /^([A-Z]{2}\d{2}[\dA-Z\s]+?)$/;

/** X-coordinate tolerance for classifying amounts into debit/credit columns */
const X_COL_TOLERANCE = 30;

/** X threshold: amounts for closing balance line are right-aligned beyond credit column */
const BALANCE_AMOUNT_X_MIN = 420;

interface ColumnPositions {
  debitX: number;
  creditX: number;
}

interface RawTx {
  date: string; // YYYY-MM-DD
  descParts: string[];
  amount: number | null;
}

/**
 * Parse a Deblock EUR account PDF statement into structured data.
 */
export function parseDeblockStatement(pages: PdfPage[]): PdfStatement {
  const warnings: string[] = [];

  if (pages.length === 0) {
    warnings.push("No pages found in PDF");
    return makeEmptyStatement(warnings);
  }

  // Verify this is a Deblock statement
  if (!isDeblockStatement(pages)) {
    warnings.push("Not a Deblock statement");
    return makeEmptyStatement(warnings);
  }

  const iban = extractIban(pages);
  const period = extractPeriod(pages);

  let columns: ColumnPositions | null = null;
  let closingBalance: number | null = null;
  let closingDate: string | null = null;

  const rawTxs: RawTx[] = [];
  let currentTx: RawTx | null = null;
  let inTable = false;
  // Track when a date line just filled in a multi-line tx, so subsequent
  // description-only lines can still append (continuation below date line).
  let justFilledMultiLine = false;

  function finalizeTx() {
    if (currentTx && currentTx.amount !== null && currentTx.date) {
      rawTxs.push(currentTx);
    }
    currentTx = null;
    justFilledMultiLine = false;
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");

      // Detect column headers
      if (!inTable || isColumnHeaderLine(line)) {
        const detected = detectDeblockColumns(line);
        if (detected) {
          finalizeTx();
          columns = detected;
          inTable = true;
          continue;
        }
      }

      // Check for closing balance line
      const closeMatch = lineText.match(CLOSING_BALANCE_RE);
      if (closeMatch) {
        finalizeTx();
        closingDate = parseFrenchDate(closeMatch[1]);
        // Look for amount on this line (right side, beyond credit column)
        const amt = findBalanceAmount(line);
        if (amt !== null) {
          closingBalance = amt;
        }
        continue;
      }

      if (!inTable || !columns) continue;

      // Skip footer/legal text
      if (/^Deblock SAS/.test(lineText)) {
        finalizeTx();
        inTable = false;
        continue;
      }

      // Try to find a French date at x=66 (the Date column)
      const dateItem = line.items.find((it) => Math.abs(it.x - 66) < 10);
      const dateStr = dateItem ? parseFrenchDate(dateItem.str.trim()) : null;

      if (dateStr) {
        // Extract description and amount from this line
        const descText = extractDescription(line, columns);
        const amount = findAmountOnLine(line, columns);

        if (currentTx && !currentTx.date) {
          // Multi-line operation: description-only line came first (above),
          // now we have the date + amount line — fill in the existing tx
          currentTx.date = dateStr;
          if (descText) currentTx.descParts.push(descText);
          if (amount !== null) currentTx.amount = amount;
          justFilledMultiLine = true;
        } else {
          // Normal single-line transaction or new transaction
          finalizeTx();
          currentTx = {
            date: dateStr,
            descParts: descText ? [descText] : [],
            amount,
          };
          justFilledMultiLine = false;
        }
      } else {
        // No date — could be:
        // 1. Start of a new multi-line operation (description before date line)
        // 2. Continuation of a multi-line operation (description after date line)

        const descItems = line.items.filter((it) =>
          it.x >= 220 && it.x < 380 && it.str.trim(),
        );
        const descText = descItems.map((it) => it.str).join(" ").trim();

        if (descText && !currentTx) {
          // No current tx — start a new multi-line tx
          currentTx = {
            date: "", // Will be filled from the next date line
            descParts: [descText],
            amount: null,
          };
          justFilledMultiLine = false;
        } else if (descText && currentTx && !currentTx.date) {
          // Multi-line tx still building (hasn't gotten date yet)
          currentTx.descParts.push(descText);
        } else if (descText && currentTx && justFilledMultiLine) {
          // Continuation of a multi-line tx after its date+amount line
          currentTx.descParts.push(descText);
        } else if (descText && currentTx && currentTx.amount !== null) {
          // Previous tx is complete (single-line), this is a new multi-line tx
          finalizeTx();
          currentTx = {
            date: "",
            descParts: [descText],
            amount: null,
          };
          justFilledMultiLine = false;
        } else if (descText && currentTx) {
          // Fallback: append to current tx
          currentTx.descParts.push(descText);
          justFilledMultiLine = false;
        }
      }
    }
  }

  finalizeTx();

  const transactions: PdfTransaction[] = rawTxs.map((raw, idx) => ({
    date: raw.date,
    description: raw.descParts.join(" "),
    amount: raw.amount!,
    index: idx,
  }));

  if (transactions.length === 0 && inTable) {
    warnings.push("No transactions found in PDF");
  }

  return {
    accountNumber: null,
    iban,
    currency: "EUR",
    openingBalance: null,
    openingDate: period?.openingDate ?? null,
    closingBalance,
    closingDate: closingDate ?? period?.closingDate ?? null,
    transactions,
    warnings,
  };
}

/**
 * Parse Deblock amount format: "1 203,55" or "7,19" or "5 000,00"
 * (space=thousands, comma=decimal). Strips "€" suffix.
 * Returns the absolute value (always positive), or null if unparseable.
 */
export function parseDeblockAmount(raw: string): number | null {
  let s = raw.trim();
  // Strip currency suffix
  s = s.replace(/€|EUR/gi, "").trim();
  if (!s) return null;
  // Remove spaces/NBSP (thousands separator)
  s = s.replace(/[\s\u00A0]/g, "");
  // Replace comma with dot (decimal separator)
  s = s.replace(",", ".");
  // Remove any remaining non-numeric chars except dot and minus
  s = s.replace(/[^\d.\-]/g, "");
  if (!s) return null;
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a French date string like "6 mars 2025" into "2025-03-06".
 * Returns null if the string doesn't match.
 */
export function parseFrenchDate(text: string): string | null {
  const match = text.trim().match(FRENCH_DATE_RE);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const monthName = match[2].toLowerCase();
  const year = parseInt(match[3], 10);

  const month = FRENCH_MONTHS[monthName];
  if (!month) return null;

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function isDeblockStatement(pages: PdfPage[]): boolean {
  for (const page of pages.slice(0, 2)) {
    for (const line of page.lines) {
      const text = line.items.map((it) => it.str).join(" ");
      if (/Deblock/.test(text)) return true;
      if (/DBLKFR/.test(text)) return true;
      if (/Relev[ée] de compte EUR/.test(text) && pages.some((p) =>
        p.lines.some((l) => l.items.some((it) => /DBLKFR|Deblock/.test(it.str))),
      )) return true;
    }
  }
  return false;
}

/**
 * Detect "Débit" and "Crédit" column header positions from a Deblock table header line.
 * Deblock headers: Date | Valeur | Opération | Débit | Crédit
 */
function detectDeblockColumns(line: PdfTextLine): ColumnPositions | null {
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

function isColumnHeaderLine(line: PdfTextLine): boolean {
  const text = line.items.map((it) => it.str).join(" ");
  return /Date/.test(text) && /bit/.test(text) && /dit/.test(text);
}

/**
 * Find an amount on a transaction line using debit/credit column positions.
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
      const parsed = parseDeblockAmount(text);
      if (parsed !== null) debitAmt = parsed;
    } else if (creditDist < X_COL_TOLERANCE) {
      const parsed = parseDeblockAmount(text);
      if (parsed !== null) creditAmt = parsed;
    }
  }

  // Debit = money out = negative, Credit = money in = positive
  if (debitAmt !== null) return -debitAmt;
  if (creditAmt !== null) return creditAmt;
  return null;
}

/**
 * Find the closing balance amount (right-aligned, past the credit column).
 */
function findBalanceAmount(line: PdfTextLine): number | null {
  for (const item of line.items) {
    if (item.x >= BALANCE_AMOUNT_X_MIN) {
      const parsed = parseDeblockAmount(item.str);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function extractDescription(line: PdfTextLine, columns: ColumnPositions): string {
  const parts: string[] = [];
  for (const item of line.items) {
    const text = item.str.trim();
    if (!text) continue;
    // Operation column: between ~225 and the debit column
    if (item.x >= 220 && item.x < columns.debitX - 10) {
      parts.push(text);
    }
  }
  return parts.join(" ");
}

function extractIban(pages: PdfPage[]): string | null {
  for (const page of pages.slice(0, 2)) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");
      if (!/IBAN/.test(lineText)) continue;

      // Look for the IBAN value among items on this line (after the "IBAN" label)
      for (const item of line.items) {
        const text = item.str.trim();
        if (text === "IBAN") continue;
        const match = text.replace(/\s+/g, "").match(/^([A-Z]{2}\d{2}[\dA-Z]+)$/);
        if (match) return match[1];
        // Handle "FR00 1774 8019 0000 0000 0000 000" — spaces in IBAN
        const cleaned = text.replace(/\s+/g, "");
        if (/^[A-Z]{2}\d{2}[\dA-Z]{10,}$/.test(cleaned)) return cleaned;
      }
    }
  }
  return null;
}

function extractPeriod(pages: PdfPage[]): { openingDate: string | null; closingDate: string | null } | null {
  for (const page of pages.slice(0, 1)) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");
      const match = lineText.match(PERIOD_RE);
      if (match) {
        return {
          openingDate: parseFrenchDate(match[1]),
          closingDate: parseFrenchDate(match[2]),
        };
      }
    }
  }
  return null;
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
