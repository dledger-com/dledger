import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { parseDate, detectDateFormat } from "../parse-date.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";

let _rules: CsvCategorizationRule[] = [];

export function setRevolutRules(rules: CsvCategorizationRule[]): void {
  _rules = rules;
}

const REVOLUT_HEADERS = ["Type", "Product", "Started Date", "Description", "Amount", "Currency", "State"];
const REVOLUT_HEADERS_ALT = ["Type", "Product", "Completed Date", "Description", "Amount", "Fee", "Currency", "Balance", "State"];

export const revolutPreset: CsvPreset = {
  id: "revolut",
  name: "Revolut",
  description: "Revolut bank statement CSV export with Type, Product, Started/Completed Date, Amount, Currency, State.",
  suggestedMainAccount: "Assets:Banks:Revolut",

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const reqMain = REVOLUT_HEADERS.map((h) => h.toLowerCase());
    const reqAlt = REVOLUT_HEADERS_ALT.map((h) => h.toLowerCase());

    const mainMatch = reqMain.filter((r) => lower.includes(r)).length;
    const altMatch = reqAlt.filter((r) => lower.includes(r)).length;

    const bestMatch = Math.max(mainMatch / reqMain.length, altMatch / reqAlt.length);
    return bestMatch >= 0.7 ? 80 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const dateCol = lower.includes("completed date")
      ? headers[lower.indexOf("completed date")]
      : lower.includes("started date")
        ? headers[lower.indexOf("started date")]
        : headers[0];

    return {
      dateColumn: dateCol,
      descriptionColumn: headers[lower.indexOf("description")],
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    // Prefer Completed Date, fall back to Started Date
    const dateIdx = col("Completed Date") >= 0 ? col("Completed Date") : col("Started Date");
    const descIdx = col("Description");
    const amtIdx = col("Amount");
    const feeIdx = col("Fee");
    const currIdx = col("Currency");
    const stateIdx = col("State");

    if (dateIdx === -1 || amtIdx === -1) return null;

    // Detect date format from samples
    const dateSamples = rows.slice(0, 20).map((r) => r[dateIdx] ?? "").filter(Boolean);
    const dateFormat = detectDateFormat(dateSamples) ?? "YYYY-MM-DD";

    // Detect number format
    const amtSamples = rows.slice(0, 20).map((r) => r[amtIdx] ?? "").filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      // Filter by State == "COMPLETED"
      if (stateIdx >= 0) {
        const state = (row[stateIdx] ?? "").trim().toUpperCase();
        if (state && state !== "COMPLETED") continue;
      }

      const rawDate = row[dateIdx] ?? "";
      const date = parseDate(rawDate, dateFormat);
      if (!date) continue;

      const description = descIdx >= 0 ? (row[descIdx] ?? "Revolut transaction") : "Revolut transaction";
      const currency = currIdx >= 0 ? (row[currIdx] ?? "EUR").trim().toUpperCase() : "EUR";
      const amount = parseAmount(row[amtIdx] ?? "", european);
      if (amount === null || amount === 0) continue;

      const fee = feeIdx >= 0 ? parseAmount(row[feeIdx] ?? "", european) : null;

      const mainAccount = `Assets:Banks:Revolut:${currency}`;
      const lines: CsvRecord["lines"] = [];

      // Main amount
      lines.push({
        account: mainAccount,
        currency,
        amount: amount.toString(),
      });

      // Determine counterparty
      const rule = matchRule(description, _rules);
      let counterAccount: string;
      if (rule) {
        counterAccount = rule.account;
      } else {
        counterAccount = amount < 0
          ? "Expenses:Uncategorized"
          : "Income:Uncategorized";
      }

      lines.push({
        account: counterAccount,
        currency,
        amount: (-amount).toString(),
      });

      // Fee line
      if (fee && Math.abs(fee) > 0) {
        lines.push({
          account: "Expenses:Banks:Revolut:Fees",
          currency,
          amount: Math.abs(fee).toString(),
        });
        lines.push({
          account: mainAccount,
          currency,
          amount: (-Math.abs(fee)).toString(),
        });
      }

      records.push({ date, description, lines });
    }

    return records;
  },
};
