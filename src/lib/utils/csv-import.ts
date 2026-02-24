import type { Backend } from "$lib/backend.js";
import { parseDate as parseDateNew, type DateFormatId } from "$lib/csv-presets/parse-date.js";
import { parseAmount } from "$lib/csv-presets/parse-amount.js";
import { importRecords } from "$lib/csv-presets/transform.js";
import type { CsvRecord } from "$lib/csv-presets/types.js";

export interface CsvColumnMapping {
  accountColumn: string;     // column name for account, or a fixed account path prefixed with "="
  currencyColumn?: string;   // column name or fixed value prefixed with "="
  amountColumn: string;      // column name
  amountNegate?: boolean;    // negate the amount (e.g. for credit columns)
}

export interface CsvImportOptions {
  delimiter?: string;           // default ","
  dateColumn: string;           // column name
  descriptionColumn?: string;   // column name
  lines: CsvColumnMapping[];    // each maps columns → a line item
  dateFormat?: string;          // "YYYY-MM-DD" (default), "MM/DD/YYYY", "DD/MM/YYYY"
}

export interface CsvImportResult {
  entries_created: number;
  accounts_created: number;
  currencies_created: number;
  warnings: string[];
  transaction_currency_dates: [string, string][];
  balance_assertion_created?: boolean;
}

function parseCsvRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export function detectDelimiter(content: string): string {
  // Sample the first few non-empty lines
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 10);
  if (lines.length === 0) return ",";

  const candidates = [",", ";", "\t", "|"];
  let bestDelim = ",";
  let bestScore = 0;

  for (const delim of candidates) {
    // Count fields per line, check consistency
    const counts = lines.map((l) => {
      // Don't count delimiters inside quotes
      let inQuotes = false;
      let count = 0;
      for (const ch of l) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === delim && !inQuotes) count++;
      }
      return count;
    });

    // Need at least 1 delimiter occurrence
    if (counts[0] === 0) continue;

    // Score: how many lines have the same count as the first line (consistency)
    const refCount = counts[0];
    const consistent = counts.filter((c) => c === refCount).length;
    const score = consistent * refCount; // prefer more fields AND more consistency

    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

export function parseCsv(content: string, delimiter = ",", skipLines = 0): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const effective = skipLines > 0 ? lines.slice(skipLines) : lines;
  if (effective.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvRow(effective[0], delimiter);
  const rows = effective.slice(1).map((l) => parseCsvRow(l, delimiter));
  return { headers, rows };
}

export async function importCsv(
  backend: Backend,
  content: string,
  options: CsvImportOptions,
): Promise<CsvImportResult> {
  const delimiter = options.delimiter ?? ",";
  const dateFormat = (options.dateFormat ?? "YYYY-MM-DD") as DateFormatId;
  const warnings: string[] = [];

  const { headers, rows } = parseCsv(content, delimiter);
  if (headers.length === 0) {
    return { entries_created: 0, accounts_created: 0, currencies_created: 0, warnings: ["Empty CSV file"], transaction_currency_dates: [] };
  }

  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h.trim(), i));

  const dateIdx = colIndex.get(options.dateColumn);
  if (dateIdx === undefined) {
    return {
      entries_created: 0, accounts_created: 0, currencies_created: 0,
      warnings: [`Date column "${options.dateColumn}" not found`],
      transaction_currency_dates: [],
    };
  }
  const descIdx = options.descriptionColumn ? colIndex.get(options.descriptionColumn) : undefined;

  // Convert rows to CsvRecord[] using the column mapping
  const records: CsvRecord[] = [];

  for (let rowNum = 0; rowNum < rows.length; rowNum++) {
    const row = rows[rowNum];
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

    // Parse date
    const rawDate = row[dateIdx] ?? "";
    const date = parseDateNew(rawDate, dateFormat);
    if (!date) {
      warnings.push(`Row ${rowNum + 2}: invalid date "${rawDate}"`);
      continue;
    }

    const description = descIdx !== undefined ? (row[descIdx] ?? "CSV Import") : "CSV Import";

    const lines: CsvRecord["lines"] = [];
    let skipRow = false;

    for (const mapping of options.lines) {
      // Resolve account
      let accountFullName: string;
      if (mapping.accountColumn.startsWith("=")) {
        accountFullName = mapping.accountColumn.slice(1);
      } else {
        const accIdx = colIndex.get(mapping.accountColumn);
        if (accIdx === undefined) {
          warnings.push(`Row ${rowNum + 2}: account column "${mapping.accountColumn}" not found`);
          skipRow = true;
          break;
        }
        accountFullName = row[accIdx] ?? "";
      }
      if (!accountFullName) continue;

      // Resolve currency
      let currency: string;
      if (mapping.currencyColumn) {
        if (mapping.currencyColumn.startsWith("=")) {
          currency = mapping.currencyColumn.slice(1);
        } else {
          const curIdx = colIndex.get(mapping.currencyColumn);
          currency = curIdx !== undefined ? (row[curIdx] ?? "USD") : "USD";
        }
      } else {
        currency = "USD";
      }

      // Resolve amount using the new parser
      const amtIdx = colIndex.get(mapping.amountColumn);
      if (amtIdx === undefined) {
        warnings.push(`Row ${rowNum + 2}: amount column "${mapping.amountColumn}" not found`);
        skipRow = true;
        break;
      }
      const rawAmt = row[amtIdx] ?? "";
      const amount = parseAmount(rawAmt);
      if (amount === null || !Number.isFinite(amount)) {
        warnings.push(`Row ${rowNum + 2}: invalid amount "${row[amtIdx]}"`);
        skipRow = true;
        break;
      }
      const finalAmount = mapping.amountNegate ? -amount : amount;

      lines.push({ account: accountFullName, currency, amount: finalAmount.toString() });
    }

    if (skipRow || lines.length === 0) continue;

    // Verify that amounts balance (sum to 0)
    const sum = lines.reduce((s, li) => s + parseFloat(li.amount), 0);
    if (Math.abs(sum) > 0.0001) {
      warnings.push(`Row ${rowNum + 2}: amounts don't balance (sum=${sum.toFixed(4)}). Skipping.`);
      continue;
    }

    records.push({ date, description, lines });
  }

  // Import all records via the shared pipeline
  const importResult = await importRecords(backend, records);
  importResult.warnings = [...warnings, ...importResult.warnings];
  return importResult;
}
