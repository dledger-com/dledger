import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { parseDate, detectDateFormat } from "../parse-date.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";

let _rules: CsvCategorizationRule[] = [];

export function setN26Rules(rules: CsvCategorizationRule[]): void {
  _rules = rules;
}

const N26_REQUIRED = ["booking date", "partner name"];
const N26_AMOUNT_PREFIX = "amount (";

/** Extract currency code from the "Amount (EUR)" header. */
function extractCurrency(headers: string[]): string {
  for (const h of headers) {
    const lower = h.trim().toLowerCase();
    if (lower.startsWith(N26_AMOUNT_PREFIX) && lower.endsWith(")")) {
      return lower.slice(N26_AMOUNT_PREFIX.length, -1).toUpperCase();
    }
  }
  return "EUR";
}

export const n26Preset: CsvPreset = {
  id: "n26",
  name: "N26",
  description: "N26 bank statement CSV export with Booking Date, Partner Name, Amount (EUR), comma-delimited, ISO dates.",
  suggestedMainAccount: "Assets:Bank:N26",

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const hasRequired = N26_REQUIRED.every((r) => lower.includes(r));
    const hasAmount = lower.some((h) => h.startsWith(N26_AMOUNT_PREFIX));
    return hasRequired && hasAmount ? 85 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    const lower = headers.map((h) => h.trim().toLowerCase());
    return {
      dateColumn: headers[lower.indexOf("booking date")] ?? "Booking Date",
      descriptionColumn: headers[lower.indexOf("partner name")] ?? "Partner Name",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    const dateIdx = col("Booking Date");
    const descIdx = col("Partner Name");
    const refIdx = col("Payment Reference");
    const amtIdx = lower.findIndex((h) => h.startsWith(N26_AMOUNT_PREFIX));

    if (dateIdx === -1 || amtIdx === -1) return null;

    const currency = extractCurrency(headers);

    // Detect date format from samples
    const dateSamples = rows.slice(0, 20).map((r) => r[dateIdx] ?? "").filter(Boolean);
    const dateFormat = detectDateFormat(dateSamples) ?? "YYYY-MM-DD";

    // Detect number format
    const amtSamples = rows.slice(0, 20).map((r) => r[amtIdx] ?? "").filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const mainAccount = `Assets:Bank:N26:${currency}`;
    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const date = parseDate(rawDate, dateFormat);
      if (!date) continue;

      // Build description: Partner Name, optionally with Payment Reference
      let description = descIdx >= 0 ? (row[descIdx] ?? "").trim() : "";
      if (!description) description = "N26 transaction";
      const ref = refIdx >= 0 ? (row[refIdx] ?? "").trim() : "";
      if (ref) description = `${description} — ${ref}`;

      const amount = parseAmount(row[amtIdx] ?? "", european);
      if (amount === null || amount === 0) continue;

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
