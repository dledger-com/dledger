import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { parseDate, detectDateFormat } from "../parse-date.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";

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

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    let realHeaders: string[];
    let dataRows: string[][];

    if (isMetadataPreamble(headers)) {
      const found = findRealHeaders(rows);
      if (!found) return null;
      [realHeaders, dataRows] = found;
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
    const descIdx = col("libellé");
    const amtIdx = col("montant");

    if (dateIdx === -1 || amtIdx === -1) return null;

    // Detect date format from samples
    const dateSamples = dataRows.slice(0, 20).map((r) => r[dateIdx] ?? "").filter(Boolean);
    const dateFormat = detectDateFormat(dateSamples) ?? "DD/MM/YYYY";

    // Detect number format
    const amtSamples = dataRows.slice(0, 20).map((r) => r[amtIdx] ?? "").filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const records: CsvRecord[] = [];

    for (const row of dataRows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const date = parseDate(rawDate, dateFormat);
      if (!date) continue;

      const description = descIdx >= 0 ? (row[descIdx] ?? "").trim() || "La Banque Postale transaction" : "La Banque Postale transaction";
      const amount = parseAmount(row[amtIdx] ?? "", european);
      if (amount === null || amount === 0) continue;

      const currency = "EUR";
      const mainAccount = `Assets:La Banque Postale:${currency}`;

      const rule = matchRule(description, _rules);
      let counterAccount: string;
      if (rule) {
        counterAccount = rule.account;
      } else {
        counterAccount = amount < 0 ? "Expenses:Uncategorized" : "Income:Uncategorized";
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
