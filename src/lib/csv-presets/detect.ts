import { detectDateFormat, type DateFormatId } from "./parse-date.js";
import { detectNumberFormat } from "./parse-amount.js";

export interface ColumnDetection {
  dateColumn: string | null;
  dateFormat: DateFormatId | null;
  descriptionColumn: string | null;
  amountColumn: string | null;
  debitAmountColumn: string | null;
  creditAmountColumn: string | null;
  currencyColumn: string | null;
  balanceColumn: string | null;
  amountMode: "single" | "split" | "unknown";
  europeanNumbers: boolean;
}

// Known header name patterns (case-insensitive)
const DATE_PATTERNS = [
  "date", "transaction date", "transaction_date", "posting_date", "posting date",
  "trade date", "time", "timestamp", "datetime", "completed date", "started date",
  "date(utc)", "created at", "created_at",
];

const DESCRIPTION_PATTERNS = [
  "description", "desc", "memo", "narrative", "payee", "details", "reference",
  "note", "notes", "transaction", "type", "product",
];

const AMOUNT_PATTERNS = ["amount", "total", "value", "sum"];

const DEBIT_PATTERNS = ["debit", "debit amount", "withdrawal", "charge", "out"];
const CREDIT_PATTERNS = ["credit", "credit amount", "deposit", "payment", "in"];

const CURRENCY_PATTERNS = ["currency", "ccy", "asset", "coin", "symbol", "ticker"];
const BALANCE_PATTERNS = ["balance", "running balance", "running_balance"];

function matchHeader(header: string, patterns: string[]): boolean {
  const h = header.trim().toLowerCase();
  return patterns.some((p) => h === p || h === p.replace(/ /g, "_"));
}

function getColumnValues(headers: string[], rows: string[][], colName: string): string[] {
  const idx = headers.findIndex((h) => h === colName);
  if (idx === -1) return [];
  return rows.map((r) => r[idx] ?? "").filter((v) => v.trim());
}

// Check if a column looks like dates by trying to parse sample values
function looksLikeDates(values: string[]): boolean {
  if (values.length === 0) return false;
  const fmt = detectDateFormat(values);
  return fmt !== null;
}

// Check if a column looks like numbers/amounts
function looksLikeAmounts(values: string[]): boolean {
  if (values.length === 0) return false;
  let numericCount = 0;
  for (const v of values) {
    const cleaned = v.replace(/[$€£¥₹₿,.\s()+-]/g, "").replace(/^[A-Z]{2,4}/i, "");
    if (/^\d+$/.test(cleaned)) numericCount++;
  }
  return numericCount / values.length >= 0.8;
}

// Check if a column looks like currency codes
function looksLikeCurrencies(values: string[]): boolean {
  if (values.length === 0) return false;
  let matches = 0;
  for (const v of values) {
    const t = v.trim().toUpperCase();
    // 2-5 letter codes (USD, EUR, BTC, USDT, etc.)
    if (/^[A-Z]{2,6}$/.test(t)) matches++;
  }
  return matches / values.length >= 0.8;
}

export function detectColumns(headers: string[], sampleRows: string[][]): ColumnDetection {
  const result: ColumnDetection = {
    dateColumn: null,
    dateFormat: null,
    descriptionColumn: null,
    amountColumn: null,
    debitAmountColumn: null,
    creditAmountColumn: null,
    currencyColumn: null,
    balanceColumn: null,
    amountMode: "unknown",
    europeanNumbers: false,
  };

  if (headers.length === 0) return result;

  const matched = new Set<string>();

  // Pass 1: header name matching
  for (const h of headers) {
    if (!result.dateColumn && matchHeader(h, DATE_PATTERNS)) {
      result.dateColumn = h;
      matched.add(h);
    }
    if (!result.descriptionColumn && matchHeader(h, DESCRIPTION_PATTERNS)) {
      result.descriptionColumn = h;
      matched.add(h);
    }
    if (!result.amountColumn && matchHeader(h, AMOUNT_PATTERNS)) {
      result.amountColumn = h;
      matched.add(h);
    }
    if (!result.debitAmountColumn && matchHeader(h, DEBIT_PATTERNS)) {
      result.debitAmountColumn = h;
      matched.add(h);
    }
    if (!result.creditAmountColumn && matchHeader(h, CREDIT_PATTERNS)) {
      result.creditAmountColumn = h;
      matched.add(h);
    }
    if (!result.currencyColumn && matchHeader(h, CURRENCY_PATTERNS)) {
      result.currencyColumn = h;
      matched.add(h);
    }
    if (!result.balanceColumn && matchHeader(h, BALANCE_PATTERNS)) {
      result.balanceColumn = h;
      matched.add(h);
    }
  }

  // Pass 2: data value sniffing for unmatched columns
  const unmatched = headers.filter((h) => !matched.has(h));

  if (!result.dateColumn) {
    for (const h of unmatched) {
      const vals = getColumnValues(headers, sampleRows, h);
      if (looksLikeDates(vals)) {
        result.dateColumn = h;
        matched.add(h);
        break;
      }
    }
  }

  if (!result.currencyColumn) {
    for (const h of unmatched) {
      if (matched.has(h)) continue;
      const vals = getColumnValues(headers, sampleRows, h);
      if (looksLikeCurrencies(vals)) {
        result.currencyColumn = h;
        matched.add(h);
        break;
      }
    }
  }

  // If no amount column found by name, look for numeric columns
  if (!result.amountColumn && !result.debitAmountColumn && !result.creditAmountColumn) {
    const numericCols: string[] = [];
    for (const h of unmatched) {
      if (matched.has(h)) continue;
      const vals = getColumnValues(headers, sampleRows, h);
      if (looksLikeAmounts(vals)) {
        numericCols.push(h);
      }
    }
    if (numericCols.length === 1) {
      result.amountColumn = numericCols[0];
      matched.add(numericCols[0]);
    }
  }

  // Detect date format
  if (result.dateColumn) {
    const vals = getColumnValues(headers, sampleRows, result.dateColumn);
    result.dateFormat = detectDateFormat(vals);
  }

  // Detect number format (European vs standard)
  const amountCol = result.amountColumn ?? result.debitAmountColumn;
  if (amountCol) {
    const vals = getColumnValues(headers, sampleRows, amountCol);
    result.europeanNumbers = detectNumberFormat(vals).european;
  }

  // Determine amount mode
  if (result.debitAmountColumn && result.creditAmountColumn) {
    result.amountMode = "split";
  } else if (result.amountColumn) {
    result.amountMode = "single";
  } else if (result.debitAmountColumn || result.creditAmountColumn) {
    result.amountMode = "single";
    // Promote to amount column
    result.amountColumn = result.debitAmountColumn ?? result.creditAmountColumn;
    result.debitAmountColumn = null;
    result.creditAmountColumn = null;
  }

  return result;
}
