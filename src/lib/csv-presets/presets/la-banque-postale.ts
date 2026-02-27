import type { CsvPreset, CsvRecord, CsvFileHeader } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { parseDate, detectDateFormat } from "../parse-date.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";
import { bankAssets, EXPENSES_UNCATEGORIZED, INCOME_UNCATEGORIZED } from "$lib/accounts/paths.js";

let _rules: CsvCategorizationRule[] = [];

export function setLaBanquePostaleRules(rules: CsvCategorizationRule[]): void {
  _rules = rules;
}

/** Check whether headers look like the metadata preamble (first line of the raw CSV). */
function isMetadataPreamble(headers: string[]): boolean {
  const first = (headers[0] ?? "").trim().toLowerCase();
  return first.includes("numéro compte") || first.includes("num") || first.includes("compte") || first.includes("type");
}

/** Find the real header row inside `rows` and return [realHeaders, dataRows]. */
function findRealHeaders(rows: string[][]): [string[], string[][]] | null {
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].map((c) => c.trim().toLowerCase());
    if (lower.includes("date") && (lower.some((c) => c.includes("libellé")) || lower.some((c) => c.includes("montant")))) {
      return [rows[i], rows.slice(i + 1)];
    }
  }
  return null;
}

function hasDirectHeaders(headers: string[]): boolean {
  const lower = headers.map((h) => h.trim().toLowerCase());
  return lower.includes("date") && (lower.some((c) => c.includes("libellé")) || lower.some((c) => c.includes("montant")));
}

/** Parse preamble rows into structured metadata. */
function parsePreambleFields(headers: string[], rows: string[][]): {
  accountID?: string;
  accountType?: string;
  currencyLabel?: string;
  balanceDate?: string;
  balanceAmount?: string;
} {
  const result: ReturnType<typeof parsePreambleFields> = {};

  // headers row is the first preamble line, e.g. ["Numéro Compte", "1234567X020"]
  const firstKey = (headers[0] ?? "").trim().toLowerCase();
  if (firstKey.includes("numéro compte") || firstKey.includes("num")) {
    result.accountID = (headers[1] ?? "").trim();
  }

  for (const row of rows) {
    const key = (row[0] ?? "").trim().toLowerCase();
    const value = (row[1] ?? "").trim();
    if (!key || !value) continue;

    if (key.includes("type")) {
      result.accountType = value;
    } else if (key.includes("compte tenu en")) {
      result.currencyLabel = value;
    } else if (key === "date" || key.startsWith("date")) {
      // Only treat as preamble date if the value looks like a date (DD/MM/YYYY)
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
        result.balanceDate = value;
      }
    } else if (key.includes("solde")) {
      result.balanceAmount = value;
    }

    // Stop scanning once we hit the real header row
    const lower = row.map((c) => c.trim().toLowerCase());
    if (lower.includes("date") && (lower.some((c) => c.includes("libellé")) || lower.some((c) => c.includes("montant")))) {
      break;
    }
  }

  return result;
}

/** Map a currency label (e.g. "euros") to a currency code. */
function currencyLabelToCode(label: string): string {
  const lower = label.toLowerCase();
  if (lower === "euros" || lower === "euro" || lower === "eur") return "EUR";
  return label.toUpperCase();
}

export const laBanquePostalePreset: CsvPreset = {
  id: "la-banque-postale",
  name: "La Banque Postale",
  description: "La Banque Postale CSV export with metadata header, semicolon-delimited, European numbers, DD/MM/YYYY.",

  detect(headers: string[], sampleRows: string[][]): number {
    // Case 1: metadata preamble as headers — scan rows for real header row
    if (isMetadataPreamble(headers)) {
      if (findRealHeaders(sampleRows)) return 85;
      return 0;
    }
    // Case 2: user skipped preamble — headers are the real ones
    if (hasDirectHeaders(headers)) return 85;
    return 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    // Try to find real headers from the metadata preamble case
    if (isMetadataPreamble(headers)) {
      return { dateColumn: "Date", descriptionColumn: "Libellé" };
    }
    const lower = headers.map((h) => h.trim().toLowerCase());
    const dateCol = headers[lower.indexOf("date")] ?? "Date";
    const descIdx = lower.findIndex((c) => c.includes("libellé"));
    const descCol = descIdx >= 0 ? headers[descIdx] : "Libellé";
    return { dateColumn: dateCol, descriptionColumn: descCol };
  },

  parseFileHeader(headers: string[], rows: string[][]): CsvFileHeader | null {
    if (!isMetadataPreamble(headers)) return null;

    const fields = parsePreambleFields(headers, rows);
    const result: CsvFileHeader = {};

    if (fields.accountID) {
      if (!result.accountMetadata) result.accountMetadata = {};
      result.accountMetadata.accountID = fields.accountID;
    }

    const currency = fields.currencyLabel ? currencyLabelToCode(fields.currencyLabel) : "EUR";
    const accountType = fields.accountType ?? currency;
    result.mainAccount = bankAssets("LaBanquePostale", accountType);

    if (fields.balanceDate) {
      const parsed = parseDate(fields.balanceDate, "DD/MM/YYYY");
      if (parsed) result.balanceDate = parsed;
    }

    if (fields.balanceAmount) {
      const parsed = parseAmount(fields.balanceAmount, true);
      if (parsed !== null) result.balanceAmount = parsed.toString();
    }

    result.balanceCurrency = currency;

    return result;
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    let realHeaders: string[];
    let dataRows: string[][];
    let fileHeader: CsvFileHeader | null = null;

    if (isMetadataPreamble(headers)) {
      const found = findRealHeaders(rows);
      if (!found) return null;
      [realHeaders, dataRows] = found;
      fileHeader = this.parseFileHeader!(headers, rows);
    } else if (hasDirectHeaders(headers)) {
      realHeaders = headers;
      dataRows = rows;
    } else {
      return null;
    }

    const lower = realHeaders.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.findIndex((c) => c.includes(name.toLowerCase()));
      return idx >= 0 ? idx : -1;
    };

    const dateIdx = col("date");
    const descIdx = col("libellé") >= 0 ? col("libellé") : lower.findIndex((c) => c.startsWith("libell"));
    const amtIdx = col("montant");

    if (dateIdx === -1 || amtIdx === -1) return null;

    // Detect date format from samples
    const dateSamples = dataRows.slice(0, 20).map((r) => r[dateIdx] ?? "").filter(Boolean);
    const dateFormat = detectDateFormat(dateSamples) ?? "DD/MM/YYYY";

    // Detect number format
    const amtSamples = dataRows.slice(0, 20).map((r) => r[amtIdx] ?? "").filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const records: CsvRecord[] = [];
    const currency = "EUR";
    // Use preamble-derived main account if available, otherwise fallback
    const mainAccount = fileHeader?.mainAccount ?? bankAssets("LaBanquePostale", currency);

    for (const row of dataRows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const date = parseDate(rawDate, dateFormat);
      if (!date) continue;

      const description = descIdx >= 0 ? (row[descIdx] ?? "").trim() || "La Banque Postale transaction" : "La Banque Postale transaction";
      const amount = parseAmount(row[amtIdx] ?? "", european);
      if (amount === null || amount === 0) continue;

      const rule = matchRule(description, _rules);
      let counterAccount: string;
      if (rule) {
        counterAccount = rule.account;
      } else {
        counterAccount = amount < 0 ? EXPENSES_UNCATEGORIZED : INCOME_UNCATEGORIZED;
      }

      records.push({
        date,
        description,
        lines: [
          { account: mainAccount, currency, amount: amount.toString() },
          { account: counterAccount, currency, amount: (-amount).toString() },
        ],
      });
    }

    return records;
  },
};
