import type { PdfPage, PdfStatement, PdfTextItem, PdfTextLine, PdfTransaction } from "../types.js";

/** Match DD.MM.YYYY date format used in new-format booking dates */
const DATE_DDMMYYYY_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** Match French long-date headers: "vendredi, 8. septembre 2017" */
const FRENCH_LONG_DATE_RE =
  /^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche),\s+(\d{1,2})\.\s+([\wéèûàô]+)\s+(\d{4})$/;

/** French month names → 1-based index */
const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12,
  // Variants without accents (pdf text extraction sometimes strips them)
  fevrier: 2, aout: 8, decembre: 12,
};

/** Match "Ancien solde" or "Solde précédent" labels */
const OPENING_BALANCE_RE = /Ancien solde|Solde pr[ée]c[ée]dent/;

/** Match "Votre nouveau solde" or "Nouveau solde" labels */
const CLOSING_BALANCE_RE = /(?:Votre )?[Nn]ouveau solde/;

/** Match IBAN — capture alphanumeric + spaces (handles "IBAN: XX... • BIC:" and "IBAN XX... BIC") */
const IBAN_RE = /IBAN[:\s]+([A-Z]{2}\d{2}[\dA-Z\s]+?)(?:\s*[•·]\s*BIC|\s+BIC|\s*$)/;

/** X threshold: items with x > this are in the amount area (right side) */
const AMOUNT_X_THRESHOLD = 470;

/** X threshold for booking date column in new format */
const BOOKING_DATE_X_MIN = 340;

/** Minimum X for description text (left margin area) */
const DESC_X_MAX = 340;

/** Y threshold: items below this are in the page footer zone (name, address, IBAN) */
const PAGE_FOOTER_Y = 80;

/** Y threshold: items above this are in the page header zone ("Relevé de compte N°...") */
const PAGE_HEADER_Y = 730;

/**
 * Detect whether the N26 PDF uses the new format (2021+) or old format (2017-2020).
 * Returns "new" if column headers are found, "old" if French long-date headers are found.
 */
export function detectN26Format(pages: PdfPage[]): "new" | "old" {
  const scanPages = pages.slice(0, 3);
  for (const page of scanPages) {
    for (const line of page.lines) {
      const text = line.items.map((it) => it.str).join(" ");
      if (/Date de r[ée]servation/.test(text) || /Montant/.test(text) && /Description/.test(text)) {
        return "new";
      }
    }
  }
  // Check for French long-date headers → old format
  for (const page of scanPages) {
    for (const line of page.lines) {
      const text = line.items.map((it) => it.str).join(" ").trim();
      if (FRENCH_LONG_DATE_RE.test(text)) {
        return "old";
      }
    }
  }
  return "new"; // default
}

/**
 * Parse an N26 PDF bank statement into structured data.
 * Auto-detects old (2017-2020) vs new (2021+) format.
 */
export function parseN26Statement(pages: PdfPage[]): PdfStatement {
  const warnings: string[] = [];

  if (pages.length === 0) {
    warnings.push("No pages found in PDF");
    return makeEmptyStatement(warnings);
  }

  const format = detectN26Format(pages);
  const iban = extractIban(pages);

  if (format === "new") {
    return parseNewFormat(pages, iban, warnings);
  } else {
    return parseOldFormat(pages, iban, warnings);
  }
}

// ─── New Format (2021+) ─────────────────────────────────────────────────────

interface RawN26Tx {
  date: string; // YYYY-MM-DD
  descParts: string[];
  amount: number | null;
}

function parseNewFormat(pages: PdfPage[], iban: string | null, warnings: string[]): PdfStatement {
  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  let openingDate: string | null = null;
  let closingDate: string | null = null;

  const rawTxs: RawN26Tx[] = [];
  let currentTx: RawN26Tx | null = null;
  let inTransactionArea = false;

  function finalizeTx() {
    if (currentTx && currentTx.amount !== null && currentTx.date) {
      rawTxs.push(currentTx);
    }
    currentTx = null;
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ");

      // Detect column header → start of transaction area
      if (/Date de r[ée]servation/.test(lineText) || (/Description/.test(lineText) && /Montant/.test(lineText))) {
        inTransactionArea = true;
        continue;
      }

      // Extract overview balances (on summary page)
      if (OPENING_BALANCE_RE.test(lineText)) {
        const amt = findAmountOnLineRight(line);
        if (amt !== null) openingBalance = amt;
        continue;
      }

      if (CLOSING_BALANCE_RE.test(lineText)) {
        const amt = findAmountOnLineRight(line);
        if (amt !== null) closingBalance = amt;
        continue;
      }

      // Extract statement period for opening/closing dates
      const periodMatch = lineText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+jusqu.au\s+(\d{2})\.(\d{2})\.(\d{4})/);
      if (periodMatch) {
        openingDate = `${periodMatch[3]}-${periodMatch[2]}-${periodMatch[1]}`;
        closingDate = `${periodMatch[6]}-${periodMatch[5]}-${periodMatch[4]}`;
        continue;
      }

      // Vue d'ensemble = summary page, stop looking for transactions
      if (/Vue d.ensemble/.test(lineText)) {
        finalizeTx();
        inTransactionArea = false;
        continue;
      }

      if (!inTransactionArea) continue;

      // Skip page footer (name, address, IBAN) and header ("Relevé de compte") zones
      if (line.y < PAGE_FOOTER_Y || line.y > PAGE_HEADER_Y) continue;

      // Look for a booking date (DD.MM.YYYY) in the date column area
      let bookingDate: string | null = null;
      let amount: number | null = null;
      const descItems: PdfTextItem[] = [];

      for (const item of line.items) {
        const text = item.str.trim();
        if (!text) continue;

        if (item.x >= BOOKING_DATE_X_MIN && item.x < AMOUNT_X_THRESHOLD) {
          const dateMatch = text.match(DATE_DDMMYYYY_RE);
          if (dateMatch) {
            bookingDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
          }
          continue;
        }

        if (item.x >= AMOUNT_X_THRESHOLD) {
          const parsed = parseN26Amount(text);
          if (parsed !== null) amount = parsed;
          continue;
        }

        // Description area
        if (item.x < DESC_X_MAX) {
          descItems.push(item);
        }
      }

      const descText = descItems.map((it) => it.str).join(" ").trim();

      if (bookingDate) {
        // New transaction
        finalizeTx();
        currentTx = {
          date: bookingDate,
          descParts: descText ? [descText] : [],
          amount,
        };
      } else if (currentTx) {
        // Continuation line
        if (descText && !/^Date de valeur/.test(descText) && !/^Page\s/.test(descText)) {
          currentTx.descParts.push(descText);
        }
        if (amount !== null && currentTx.amount === null) {
          currentTx.amount = amount;
        }
      }
    }
  }

  finalizeTx();

  const transactions: PdfTransaction[] = rawTxs.map((raw, idx) => {
    const { description, metadata } = extractN26Metadata(raw.descParts.join(" "));
    return {
      date: raw.date, description, amount: raw.amount!, index: idx,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });

  if (transactions.length === 0) {
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

// ─── Old Format (2017-2020) ─────────────────────────────────────────────────

function parseOldFormat(pages: PdfPage[], iban: string | null, warnings: string[]): PdfStatement {
  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  let openingDate: string | null = null;
  let closingDate: string | null = null;

  const rawTxs: RawN26Tx[] = [];
  let currentTx: RawN26Tx | null = null;
  let currentDate: string | null = null;

  function finalizeTx() {
    if (currentTx && currentTx.amount !== null && currentTx.date) {
      rawTxs.push(currentTx);
    }
    currentTx = null;
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const lineText = line.items.map((it) => it.str).join(" ").trim();

      // Extract statement period from header
      const periodLong = lineText.match(
        /(\d{1,2})\.\s+([\wéèûàô]+)\s+(\d{4})\s+jusqu.au\s+(\d{1,2})\.\s+([\wéèûàô]+)\s+(\d{4})/,
      );
      if (periodLong) {
        openingDate = formatLongDate(periodLong[1], periodLong[2], periodLong[3]);
        closingDate = formatLongDate(periodLong[4], periodLong[5], periodLong[6]);
        continue;
      }

      // Extract overview balances
      if (OPENING_BALANCE_RE.test(lineText)) {
        const amt = findAmountOnLineRight(line);
        if (amt !== null) openingBalance = amt;
        continue;
      }
      if (CLOSING_BALANCE_RE.test(lineText)) {
        const amt = findAmountOnLineRight(line);
        if (amt !== null) closingBalance = amt;
        continue;
      }

      // Vue d'ensemble = summary page
      if (/Vue d.ensemble/.test(lineText)) {
        finalizeTx();
        continue;
      }

      // French long-date header → new date group
      const longDate = parseFrenchLongDate(lineText);
      if (longDate) {
        finalizeTx();
        currentDate = longDate;
        continue;
      }

      if (!currentDate) continue;

      // Skip page footer (name, address, IBAN) and header ("Relevé de compte") zones
      if (line.y < PAGE_FOOTER_Y || line.y > PAGE_HEADER_Y) continue;

      // Check if line has an amount on the right side
      const amount = findAmountOnLineRight(line);
      const descItems = line.items.filter((it) => it.x < AMOUNT_X_THRESHOLD);
      const descText = descItems.map((it) => it.str).join(" ").trim();

      if (amount !== null) {
        if (currentTx) {
          // Amount found — could be on the same tx or starting a new one
          if (currentTx.amount === null) {
            // This tx was missing its amount
            currentTx.amount = amount;
            if (descText && !/^Page\s/.test(descText)) {
              currentTx.descParts.push(descText);
            }
          } else {
            // Previous tx already had amount, this is a new tx with amount on first line
            finalizeTx();
            currentTx = {
              date: currentDate,
              descParts: descText ? [descText] : [],
              amount,
            };
          }
        } else {
          // No current tx, start new one
          currentTx = {
            date: currentDate,
            descParts: descText ? [descText] : [],
            amount,
          };
        }
      } else if (descText && !/^Page\s/.test(descText)) {
        if (!currentTx) {
          // First line of a new transaction (description only, no amount yet)
          currentTx = {
            date: currentDate,
            descParts: [descText],
            amount: null,
          };
        } else if (currentTx.amount !== null) {
          // Previous tx already complete, this is a new tx
          finalizeTx();
          currentTx = {
            date: currentDate,
            descParts: [descText],
            amount: null,
          };
        } else {
          // Continuation line
          currentTx.descParts.push(descText);
        }
      }
    }
  }

  finalizeTx();

  const transactions: PdfTransaction[] = rawTxs.map((raw, idx) => {
    const { description, metadata } = extractN26Metadata(raw.descParts.join(" "));
    return {
      date: raw.date, description, amount: raw.amount!, index: idx,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });

  if (transactions.length === 0) {
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

/** IBAN+BIC pattern: "IBAN: XX... • BIC: YY..." or "IBAN: XX... BIC: YY..." */
const IBAN_BIC_RE = /IBAN[:\s]+([A-Z]{2}\d{2}[\dA-Z\s]+?)\s*[•·]?\s*BIC[:\s]+(\S+)/;
/** Standalone IBAN pattern (no BIC) */
const IBAN_ONLY_RE = /IBAN[:\s]+([A-Z]{2}\d{2}[\dA-Z\s]+?)(?:\s*$|\s+(?!BIC))/;

/** Transaction type keywords, ordered by specificity (longer/more specific first) */
const TX_TYPE_KEYWORDS: { pattern: RegExp; type: string; extra?: Record<string, string> }[] = [
  { pattern: /Commission sur les virements instantan[ée]s/, type: "instant-transfer-fee" },
  { pattern: /ATM Withdrawal Fee/, type: "atm-fee" },
  { pattern: /Virements sortants/, type: "transfer-out" },
  { pattern: /Virements entrants/, type: "transfer-in" },
  { pattern: /Pr[ée]l[èe]vement(?:\s+SEPA)?/, type: "direct-debit" },
  { pattern: /Remboursement/, type: "refund" },
  { pattern: /Mastercard/, type: "card-payment", extra: { "card-type": "mastercard" } },
  { pattern: /Revenus/, type: "income" },
];

/**
 * Extract structured metadata from an N26 transaction description.
 * Returns a cleaned description and a metadata record with fields like
 * bank-category, transaction-type, card-type, iban, bic, reference.
 */
export function extractN26Metadata(rawDesc: string): { description: string; metadata: Record<string, string> } {
  const metadata: Record<string, string> = {};
  let text = rawDesc;

  // Step 1 — Extract IBAN + BIC (must be first to avoid bullet confusion)
  const ibanBicMatch = text.match(IBAN_BIC_RE);
  if (ibanBicMatch) {
    metadata.iban = ibanBicMatch[1].replace(/\s+/g, "");
    metadata.bic = ibanBicMatch[2].trim();
    text = text.replace(ibanBicMatch[0], " ");
  } else {
    const ibanMatch = text.match(IBAN_ONLY_RE);
    if (ibanMatch) {
      metadata.iban = ibanMatch[1].replace(/\s+/g, "");
      text = text.replace(ibanMatch[0], " ");
    }
  }

  // Step 2 — Split at first remaining bullet (• or ·)
  const bulletIdx = text.search(/\s+[•·]\s+/);
  if (bulletIdx !== -1) {
    const bulletMatch = text.slice(bulletIdx).match(/^(\s+[•·]\s+)/);
    if (bulletMatch) {
      const category = text.slice(bulletIdx + bulletMatch[1].length).trim();
      if (category) metadata["bank-category"] = category;
      text = text.slice(0, bulletIdx);
    }
  }

  // Step 3 — Match transaction type keyword
  for (const kw of TX_TYPE_KEYWORDS) {
    const kwMatch = text.match(kw.pattern);
    if (kwMatch) {
      metadata["transaction-type"] = kw.type;
      if (kw.extra) Object.assign(metadata, kw.extra);

      const before = text.slice(0, kwMatch.index!).trim();
      const after = text.slice(kwMatch.index! + kwMatch[0].length).trim();

      if (after) metadata.reference = after;
      // If stripping keyword leaves description empty, keep original text
      text = before || rawDesc;
      break;
    }
  }

  // Step 4 — Trim and normalize whitespace
  const description = text.replace(/\s+/g, " ").trim();

  return { description, metadata };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Parse N26 amount format: "+2.000,00€" / "-1.352,09€" / "+0,50€"
 * Returns the signed numeric value, or null if unparseable.
 */
export function parseN26Amount(raw: string): number | null {
  let s = raw.trim();
  // Strip currency suffix
  s = s.replace(/€|EUR/gi, "").trim();
  if (!s) return null;

  // Determine sign
  let sign = 1;
  if (s.startsWith("+")) {
    s = s.substring(1);
  } else if (s.startsWith("-")) {
    sign = -1;
    s = s.substring(1);
  }

  // Strip spaces
  s = s.replace(/[\s\u00A0]/g, "");

  // European format: dot=thousands, comma=decimal
  // Remove dots (thousands separator), replace comma with dot (decimal)
  s = s.replace(/\./g, "");
  s = s.replace(",", ".");

  if (!s) return null;
  const num = parseFloat(s);
  return Number.isFinite(num) ? sign * num : null;
}

/**
 * Parse a French long-date string like "vendredi, 8. septembre 2017" into "2017-09-08".
 * Returns null if the string doesn't match the expected format.
 */
export function parseFrenchLongDate(text: string): string | null {
  const match = text.trim().match(FRENCH_LONG_DATE_RE);
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

/**
 * Find an amount value on the right side of a line (x >= AMOUNT_X_THRESHOLD).
 */
function findAmountOnLineRight(line: PdfTextLine): number | null {
  for (const item of line.items) {
    if (item.x >= AMOUNT_X_THRESHOLD) {
      const parsed = parseN26Amount(item.str);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function formatLongDate(day: string, monthName: string, year: string): string | null {
  const month = FRENCH_MONTHS[monthName.toLowerCase()];
  if (!month) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(parseInt(day, 10)).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function extractIban(pages: PdfPage[]): string | null {
  // The account holder's IBAN is in the page header area (low Y coordinates, ~y=38-41).
  // Transaction IBANs appear at higher Y values. We want the header IBAN.
  // Scan lines in reverse order (ascending Y) to find header IBAN first.
  for (const page of pages.slice(0, 2)) {
    const reversed = [...page.lines].reverse();
    for (const line of reversed) {
      const text = line.items.map((it) => it.str).join(" ");
      const match = text.match(IBAN_RE);
      if (match) {
        return match[1].replace(/\s+/g, "").trim();
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
