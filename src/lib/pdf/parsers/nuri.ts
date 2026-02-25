import type { PdfPage, PdfStatement, PdfTextLine, PdfTransaction } from "../types.js";

/** Match DD/MM/YYYY date format */
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Match "Balance on DD/MM/YYYY: XX.XX EUR" (the "on" word may be a separate item or absent) */
const BALANCE_RE = /Balance\s+(?:on\s+)?(\d{2})\/(\d{2})\/(\d{4}):\s*([\d.,\-]+)\s*EUR/;

/** Match standalone IBAN value (letters + digits, starts with 2 letters + 2 digits) */
const IBAN_VALUE_RE = /^([A-Z]{2}\d{2}[\dA-Z]+)$/;

/** X threshold: items at or beyond this are in the amount column */
const AMOUNT_X_THRESHOLD = 480;

/** Minimum gap between columns to distinguish "date area" from "description area" */
const COL_GAP = 40;

interface ColumnLayout {
  /** "old" = Value Date | Booking Date | Action | Amount; "new" = Action | Value Date | Booking Date | Amount */
  variant: "old" | "new";
  valueDateX: number;
  bookingDateX: number;
  actionX: number;
  amountX: number;
}

interface RawTx {
  date: string; // YYYY-MM-DD
  descParts: string[];
  amount: number | null;
}

/**
 * Detect whether a Nuri/Bitwala PDF uses the old or new column layout.
 * Old (2020-2021): Value Date | Booking Date | Action | Amount
 * New (2022+): Action | Value Date | Booking Date | Amount
 */
export function detectNuriFormat(pages: PdfPage[]): "old" | "new" {
  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");
      if (!/Amount/.test(lineText)) continue;
      // New layout: Action comes before Value Date
      if (/Action/.test(lineText) && /Value\s+Date/.test(lineText)) {
        const actionIdx = lineText.indexOf("Action");
        const valueIdx = lineText.indexOf("Value");
        if (actionIdx < valueIdx) return "new";
        return "old";
      }
    }
  }
  return "old";
}

/**
 * Parse a Nuri (formerly Bitwala) / solarisBank PDF statement.
 * Auto-detects old vs new column layout.
 */
export function parseNuriStatement(pages: PdfPage[]): PdfStatement {
  const warnings: string[] = [];

  if (pages.length === 0) {
    warnings.push("No pages found in PDF");
    return makeEmptyStatement(warnings);
  }

  // Detect if this is a solarisBank / Nuri / Bitwala statement
  if (!isSolarisStatement(pages)) {
    warnings.push("Not a solarisBank/Nuri/Bitwala statement");
    return makeEmptyStatement(warnings);
  }

  const iban = extractIban(pages);
  const columns = detectColumns(pages);

  if (!columns) {
    warnings.push("No column headers found");
    return makeEmptyStatement(warnings);
  }

  let openingBalance: number | null = null;
  let openingDate: string | null = null;
  let closingBalance: number | null = null;
  let closingDate: string | null = null;

  const rawTxs: RawTx[] = [];
  let currentTx: RawTx | null = null;
  let pastHeaders = false;

  function finalizeTx() {
    if (currentTx && currentTx.amount !== null && currentTx.date) {
      rawTxs.push(currentTx);
    }
    currentTx = null;
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");

      // Extract balance lines
      const balMatch = lineText.match(BALANCE_RE);
      if (balMatch) {
        const date = `${balMatch[3]}-${balMatch[2]}-${balMatch[1]}`;
        const amount = parseFloat(balMatch[4]);
        if (Number.isFinite(amount)) {
          if (openingDate === null) {
            openingDate = date;
            openingBalance = amount;
          } else {
            closingDate = date;
            closingBalance = amount;
          }
        }
        finalizeTx();
        continue;
      }

      // Detect column header line
      if (isColumnHeader(line)) {
        pastHeaders = true;
        continue;
      }

      if (!pastHeaders) continue;

      // Skip boilerplate / footer
      if (/Empowered by|solarisBank|Page\s+\d/.test(lineText)) continue;
      if (/^\d+\/\d+$/.test(lineText.trim())) continue; // page numbers like "1/2"

      // Try to find dates on this line
      const dateInfo = extractDateFromLine(line, columns);

      if (dateInfo) {
        // New transaction
        finalizeTx();

        const descText = extractDescription(line, columns);
        const amount = extractAmount(line);

        currentTx = {
          date: dateInfo,
          descParts: descText ? [descText] : [],
          amount,
        };
      } else if (currentTx) {
        // Continuation line — append description
        const descText = extractDescription(line, columns);
        if (descText) {
          currentTx.descParts.push(descText);
        }
        // If we still don't have an amount, check this line
        if (currentTx.amount === null) {
          const amt = extractAmount(line);
          if (amt !== null) currentTx.amount = amt;
        }
      }
    }
  }

  finalizeTx();

  const transactions: PdfTransaction[] = rawTxs.map((raw, idx) => ({
    date: raw.date,
    description: raw.descParts.join(", "),
    amount: raw.amount!,
    index: idx,
  }));

  if (transactions.length === 0 && pastHeaders) {
    warnings.push("No transactions found in PDF");
  }

  return {
    accountNumber: null,
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
 * Parse a Nuri/Bitwala amount. Simple dot-decimal with optional negative sign.
 */
export function parseNuriAmount(raw: string): number | null {
  let s = raw.trim();
  s = s.replace(/\s*EUR\s*/gi, "");
  s = s.replace(/[\s\u00A0]/g, "");
  if (!s) return null;
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function isSolarisStatement(pages: PdfPage[]): boolean {
  for (const page of pages.slice(0, 2)) {
    for (const line of page.lines) {
      const text = line.items.map((it) => it.str).join(" ");
      if (/Statement of Account/.test(text)) return true;
      if (/solarisBank/.test(text)) return true;
    }
  }
  return false;
}

function isColumnHeader(line: PdfTextLine): boolean {
  const lineText = line.items.map((it) => it.str).join(" ");
  return /Value\s+Date/.test(lineText) && /Amount/.test(lineText);
}

function detectColumns(pages: PdfPage[]): ColumnLayout | null {
  for (const page of pages) {
    for (const line of page.lines) {
      if (!isColumnHeader(line)) continue;

      let valueDateX = 0;
      let bookingDateX = 0;
      let actionX = 0;
      let amountX = 0;

      for (const item of line.items) {
        const text = item.str.trim();
        // pdfjs may split "Value Date" into "Value" + "Date", so match first word
        if (text === "Value Date" || text === "Value") {
          if (!valueDateX) valueDateX = item.x;
        } else if (text === "Booking Date" || text === "Booking") {
          if (!bookingDateX) bookingDateX = item.x;
        } else if (text === "Action") actionX = item.x;
        else if (text === "Amount") amountX = item.x;
      }

      if (valueDateX && amountX) {
        const variant = actionX < valueDateX ? "new" : "old";
        return { variant, valueDateX, bookingDateX, actionX, amountX };
      }
    }
  }
  return null;
}

function extractDateFromLine(line: PdfTextLine, columns: ColumnLayout): string | null {
  // Find an item near the valueDateX column that matches DD/MM/YYYY
  for (const item of line.items) {
    const dist = Math.abs(item.x - columns.valueDateX);
    if (dist > COL_GAP) continue;
    const match = item.str.trim().match(DATE_RE);
    if (match) {
      return `${match[3]}-${match[2]}-${match[1]}`;
    }
  }
  return null;
}

function extractDescription(line: PdfTextLine, columns: ColumnLayout): string {
  const parts: string[] = [];
  for (const item of line.items) {
    const text = item.str.trim();
    if (!text) continue;
    // Skip date columns and amount column
    if (Math.abs(item.x - columns.valueDateX) < COL_GAP) continue;
    if (Math.abs(item.x - columns.bookingDateX) < COL_GAP) continue;
    if (item.x >= AMOUNT_X_THRESHOLD) continue;
    // This is in the description/action area
    parts.push(text);
  }
  return parts.join(" ");
}

function extractAmount(line: PdfTextLine): number | null {
  for (const item of line.items) {
    if (item.x >= AMOUNT_X_THRESHOLD) {
      const parsed = parseNuriAmount(item.str);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function extractIban(pages: PdfPage[]): string | null {
  for (const page of pages.slice(0, 2)) {
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const lineText = line.items.map((it) => it.str).join(" ");
      if (!/IBAN/.test(lineText)) continue;

      // Look for the IBAN value among items on this line
      for (const item of line.items) {
        const text = item.str.trim().replace(/^IBAN:?\s*/, "");
        if (!text) continue;
        const match = text.match(IBAN_VALUE_RE);
        if (match) return match[1];
      }

      // IBAN value may be on the next line
      const nextLine = page.lines[i + 1];
      if (nextLine) {
        for (const item of nextLine.items) {
          const match = item.str.trim().match(IBAN_VALUE_RE);
          if (match) return match[1];
        }
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
