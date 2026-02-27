import type { CsvRecord, CsvFileHeader } from "$lib/csv-presets/types.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { matchRule } from "$lib/csv-presets/categorize.js";
import type { OfxStatement, OfxTransaction } from "./parse-ofx.js";
import { parseOfxDate } from "./parse-ofx.js";
import { INCOME_UNCATEGORIZED, EXPENSES_UNCATEGORIZED, creditCard, bankAssets } from "$lib/accounts/paths.js";

export interface OfxConvertOptions {
  mainAccount: string;
  rules: CsvCategorizationRule[];
}

export interface OfxConvertResult {
  records: CsvRecord[];
  fileHeader: CsvFileHeader;
  warnings: string[];
}

function buildDescription(tx: OfxTransaction): string {
  const parts: string[] = [];
  if (tx.name) parts.push(tx.name);
  if (tx.memo) parts.push(tx.memo);
  return parts.join(" - ") || tx.trnType;
}

/**
 * Convert a parsed OFX statement into CsvRecord[] for import via the existing pipeline.
 */
export function convertOfxToRecords(
  statement: OfxStatement,
  options: OfxConvertOptions,
): OfxConvertResult {
  const records: CsvRecord[] = [];
  const warnings: string[] = [];
  const currency = statement.currency;

  for (const tx of statement.transactions) {
    const date = parseOfxDate(tx.dtPosted);
    if (!date) {
      warnings.push(`Skipped transaction ${tx.fitId}: invalid date "${tx.dtPosted}"`);
      continue;
    }

    const amount = parseFloat(tx.trnAmt);
    if (!Number.isFinite(amount) || amount === 0) {
      warnings.push(`Skipped transaction ${tx.fitId}: invalid amount "${tx.trnAmt}"`);
      continue;
    }

    const description = buildDescription(tx);

    // Determine counter account via categorization rules
    const rule = matchRule(description, options.rules);
    let counterAccount: string;
    if (rule) {
      counterAccount = rule.account;
    } else {
      // Positive amount = money in (income), negative = money out (expense)
      // In OFX: positive = credit to account, negative = debit from account
      counterAccount = amount > 0 ? INCOME_UNCATEGORIZED : EXPENSES_UNCATEGORIZED;
    }

    records.push({
      date,
      description,
      lines: [
        { account: options.mainAccount, currency, amount: amount.toString() },
        { account: counterAccount, currency, amount: (-amount).toString() },
      ],
      sourceKey: tx.fitId,
    });
  }

  // Build file header from statement metadata
  const fileHeader: CsvFileHeader = {};
  const accountMeta: Record<string, string> = {};

  if (statement.account.acctId) {
    accountMeta.accountID = statement.account.acctId;
  }
  if (statement.account.bankId) {
    accountMeta.bankID = statement.account.bankId;
  }
  if (statement.account.acctType) {
    accountMeta.accountType = statement.account.acctType;
  }

  if (Object.keys(accountMeta).length > 0) {
    fileHeader.accountMetadata = accountMeta;
  }

  if (statement.ledgerBalance) {
    const balDate = parseOfxDate(statement.ledgerBalance.dtAsOf);
    if (balDate) {
      fileHeader.balanceDate = balDate;
      fileHeader.balanceAmount = statement.ledgerBalance.balAmt;
      fileHeader.balanceCurrency = currency;
    }
  }

  if (statement.currency) {
    fileHeader.mainAccount = options.mainAccount;
  }

  return { records, fileHeader, warnings };
}

/**
 * Suggest a main account name from OFX account info.
 */
export function suggestMainAccount(statement: OfxStatement): string {
  const last4 = statement.account.acctId?.slice(-4) ?? "Unknown";
  if (statement.account.accountType === "creditcard") {
    return creditCard(last4);
  }
  const type = statement.account.acctType ?? "Checking";
  return bankAssets(type, last4);
}
