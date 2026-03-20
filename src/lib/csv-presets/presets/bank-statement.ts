import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parseDate, detectDateFormat } from "../parse-date.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";
import { ASSETS_BANK_IMPORT, EXPENSES_UNCATEGORIZED, INCOME_UNCATEGORIZED } from "$lib/accounts/paths.js";

let _rules: CsvCategorizationRule[] = [];

export function setBankStatementRules(rules: CsvCategorizationRule[]): void {
  _rules = rules;
}

export function getBankStatementRules(): CsvCategorizationRule[] {
  return _rules;
}

function headerScore(headers: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  let score = 0;

  // Date
  if (lower.some((h) =>
    ["date", "transaction date", "transaction_date", "posting_date", "posting date", "booking date"].includes(h),
  )) score += 10;

  // Description
  if (lower.some((h) =>
    ["description", "desc", "memo", "narrative", "payee", "details", "reference"].includes(h),
  )) score += 10;

  // Amount (single or split)
  if (lower.some((h) => ["amount", "total", "value"].includes(h))) score += 10;
  if (lower.some((h) => ["debit", "withdrawal", "charge"].includes(h))) score += 10;
  if (lower.some((h) => ["credit", "deposit", "payment"].includes(h))) score += 10;

  // Balance
  if (lower.some((h) => ["balance", "running balance", "running_balance"].includes(h))) score += 10;

  // Cap at 60
  return Math.min(score, 60);
}

export const bankStatementPreset: CsvPreset = {
  id: "bank-statement",
  name: "Bank Statement",
  description: "Generic bank statement CSV with date, description, amount, and optional balance columns.",

  detect(headers: string[], _sampleRows: string[][]): number {
    return headerScore(headers);
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    const lower = headers.map((h) => h.trim().toLowerCase());

    const dateCol = headers[lower.findIndex((h) =>
      ["date", "transaction date", "transaction_date", "posting_date", "posting date"].includes(h),
    )] ?? headers[0];

    const descCol = headers[lower.findIndex((h) =>
      ["description", "desc", "memo", "narrative", "payee", "details"].includes(h),
    )];

    return {
      dateColumn: dateCol,
      descriptionColumn: descCol,
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());

    // Find date column
    const dateIdx = lower.findIndex((h) =>
      ["date", "transaction date", "transaction_date", "posting_date", "posting date", "booking date"].includes(h),
    );
    if (dateIdx === -1) return null;

    // Find description column
    const descIdx = lower.findIndex((h) =>
      ["description", "desc", "memo", "narrative", "payee", "details", "reference"].includes(h),
    );

    // Find amount column(s)
    const amtIdx = lower.findIndex((h) => ["amount", "total", "value"].includes(h));
    const debitIdx = lower.findIndex((h) => ["debit", "withdrawal", "charge"].includes(h));
    const creditIdx = lower.findIndex((h) => ["credit", "deposit", "payment"].includes(h));

    // Find currency column
    const currIdx = lower.findIndex((h) => ["currency", "ccy"].includes(h));

    // Detect date format
    const dateSamples = rows.slice(0, 20).map((r) => r[dateIdx] ?? "").filter(Boolean);
    const dateFormat = detectDateFormat(dateSamples) ?? "YYYY-MM-DD";

    // Detect number format
    const amtSamples = rows.slice(0, 20).map((r) => {
      if (amtIdx >= 0) return r[amtIdx] ?? "";
      if (debitIdx >= 0) return r[debitIdx] ?? "";
      return "";
    }).filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const bankAccount = ASSETS_BANK_IMPORT;
    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const date = parseDate(rawDate, dateFormat);
      if (!date) continue;

      const description = descIdx >= 0 ? (row[descIdx] ?? "Bank transaction") : "Bank transaction";
      const currency = currIdx >= 0 ? (row[currIdx] ?? "USD").trim().toUpperCase() : "USD";

      let amount: number | null = null;
      if (amtIdx >= 0) {
        amount = parseAmount(row[amtIdx] ?? "", european);
      } else if (debitIdx >= 0 || creditIdx >= 0) {
        const debit = debitIdx >= 0 ? parseAmount(row[debitIdx] ?? "", european) : null;
        const credit = creditIdx >= 0 ? parseAmount(row[creditIdx] ?? "", european) : null;
        if (debit && Math.abs(debit) > 0) amount = -Math.abs(debit);
        else if (credit && Math.abs(credit) > 0) amount = Math.abs(credit);
      }

      if (amount === null || amount === 0) continue;

      // Determine counterparty account via categorization rules
      const rule = matchRule(description, _rules);
      let counterAccount: string;
      if (rule) {
        counterAccount = rule.account;
      } else {
        counterAccount = amount < 0
          ? EXPENSES_UNCATEGORIZED
          : INCOME_UNCATEGORIZED;
      }

      // Bank account: negative = money out (debit expense), positive = money in (credit income)
      records.push({
        date,
        description,
        descriptionData: { type: "bank", bank: "", text: description },
        lines: [
          { account: bankAccount, currency, amount: amount.toString() },
          { account: counterAccount, currency, amount: (-amount).toString() },
        ],
      });
    }

    return records;
  },
};
