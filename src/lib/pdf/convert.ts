import type { CsvRecord, CsvFileHeader } from "$lib/csv-presets/types.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { matchRule } from "$lib/csv-presets/categorize.js";
import type { PdfStatement } from "./types.js";

export interface PdfConvertOptions {
  mainAccount: string;
  rules: CsvCategorizationRule[];
  bankId?: "lbp" | "n26" | "nuri" | "deblock";
}

export interface PdfConvertResult {
  records: CsvRecord[];
  fileHeader: CsvFileHeader;
  warnings: string[];
}

/**
 * Convert a parsed PDF statement into CsvRecord[] for import via the existing pipeline.
 */
export function convertPdfToRecords(
  statement: PdfStatement,
  options: PdfConvertOptions,
): PdfConvertResult {
  const records: CsvRecord[] = [];
  const warnings: string[] = [];
  const currency = statement.currency;

  for (const tx of statement.transactions) {
    if (!tx.date || tx.amount === 0) {
      warnings.push(`Skipped transaction #${tx.index}: invalid date or zero amount`);
      continue;
    }

    // Determine counter account via categorization rules
    const rule = matchRule(tx.description, options.rules);
    let counterAccount: string;
    if (rule) {
      counterAccount = rule.account;
    } else {
      // Positive amount = money in (credit), negative = money out (debit)
      counterAccount = tx.amount > 0 ? "Income:Uncategorized" : "Expenses:Uncategorized";
    }

    const amountStr = tx.amount.toString();
    const counterAmountStr = (-tx.amount).toString();

    records.push({
      date: tx.date,
      description: tx.description,
      lines: [
        { account: options.mainAccount, currency, amount: amountStr },
        { account: counterAccount, currency, amount: counterAmountStr },
      ],
      sourceKey: `${statement.closingDate ?? "unknown"}:${tx.index}`,
    });
  }

  // Build file header
  const fileHeader: CsvFileHeader = {
    mainAccount: options.mainAccount,
  };

  if (statement.closingBalance !== null && statement.closingDate) {
    fileHeader.balanceDate = statement.closingDate;
    fileHeader.balanceAmount = statement.closingBalance.toString();
    fileHeader.balanceCurrency = currency;
  }

  const accountMeta: Record<string, string> = {};
  if (statement.accountNumber) {
    accountMeta.accountNumber = statement.accountNumber;
  }
  if (statement.iban) {
    accountMeta.iban = statement.iban;
  }
  if (Object.keys(accountMeta).length > 0) {
    fileHeader.accountMetadata = accountMeta;
  }

  return { records, fileHeader, warnings };
}

/**
 * Suggest a main account name from PDF statement info.
 */
export function suggestMainAccount(statement: PdfStatement, bankId?: "lbp" | "n26" | "nuri" | "deblock"): string {
  if (bankId === "n26") {
    return "Assets:Banks:N26";
  }
  if (bankId === "nuri") {
    return "Assets:Banks:Nuri";
  }
  if (bankId === "deblock") {
    return "Assets:Banks:Deblock";
  }
  const acctNum = statement.accountNumber ?? statement.iban;
  const last4 = acctNum?.replace(/\s/g, "").slice(-4) ?? "Unknown";
  return `Assets:Banks:LaBanquePostale:${last4}`;
}
