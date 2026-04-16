import type { CsvRecord, CsvFileHeader } from "$lib/csv-presets/types.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { matchRule } from "$lib/csv-presets/categorize.js";
import { bankDescription, renderDescription } from "$lib/types/description-data.js";
import {
  INCOME_UNCATEGORIZED,
  EXPENSES_UNCATEGORIZED,
  bankAssets,
  creditCard,
  bankNameFromAccount,
} from "$lib/accounts/paths.js";
import type { QifSection, QifTransaction, QifDateFormat } from "./parse-qif.js";
import { parseQifDate, isTransfer } from "./parse-qif.js";

export interface QifConvertOptions {
  mainAccount: string;
  rules: CsvCategorizationRule[];
  bankName?: string;
  dateFormat: QifDateFormat;
  europeanNumbers?: boolean;
  accountMapping?: Map<string, string>;
}

export interface QifConvertResult {
  records: CsvRecord[];
  fileHeader: CsvFileHeader;
  warnings: string[];
  unmappedAccounts: string[];
}

/**
 * Parse a QIF amount string to a number.
 * Handles US format (1,234.56) and European format (1.234,56).
 */
export function parseQifAmount(raw: string, european = false): number | null {
  let cleaned = raw.trim();
  if (!cleaned) return null;

  if (european) {
    // European: strip dot thousands separator, convert comma decimal to dot
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // US: strip comma thousands separator (already done in parser, but be safe)
    cleaned = cleaned.replace(/,/g, "");
  }

  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function buildDescription(tx: QifTransaction): string {
  const parts: string[] = [];
  if (tx.payee) parts.push(tx.payee);
  if (tx.memo) parts.push(tx.memo);
  return parts.join(" - ") || "QIF Transaction";
}

function buildSourceKey(date: string, tx: QifTransaction, amount: number): string {
  const payee = tx.payee ?? "";
  const check = tx.checkNum ?? "";
  return `qif:${date}:${payee}:${amount}:${check}`;
}

/**
 * Resolve a QIF category to a dledger account path.
 * Handles both regular categories and transfer notation [AccountName].
 */
function resolveCategory(
  category: string,
  amount: number,
  accountMapping: Map<string, string> | undefined,
  unmappedAccounts: Set<string>,
): string {
  const transfer = isTransfer(category);
  if (transfer.isTransfer) {
    const mapped = accountMapping?.get(transfer.accountName);
    if (mapped) return mapped;
    unmappedAccounts.add(transfer.accountName);
    // Auto-normalize: best guess from account name
    return `Assets:Bank:${transfer.accountName}`;
  }

  // Regular category — map colon-separated QIF category to dledger account path
  // QIF uses Category:Subcategory, which maps naturally to dledger's colon paths
  // but we need to add a top-level prefix
  if (category.trim()) {
    return category.trim();
  }

  return amount > 0 ? INCOME_UNCATEGORIZED : EXPENSES_UNCATEGORIZED;
}

/**
 * Convert a parsed QIF section into CsvRecord[] for import via the existing pipeline.
 */
export function convertQifToRecords(
  section: QifSection,
  options: QifConvertOptions,
): QifConvertResult {
  const records: CsvRecord[] = [];
  const warnings: string[] = [];
  const unmappedSet = new Set<string>();
  const bank = options.bankName ?? bankNameFromAccount(options.mainAccount);
  const european = options.europeanNumbers ?? false;

  for (const tx of section.transactions) {
    const date = parseQifDate(tx.date, options.dateFormat);
    if (!date) {
      warnings.push(`Skipped transaction: invalid date "${tx.date}"`);
      continue;
    }

    // Prefer U (higher precision) over T
    const amountRaw = tx.amountU ?? tx.amount;
    const amount = parseQifAmount(amountRaw, european);
    if (amount === null || amount === 0) {
      warnings.push(`Skipped transaction: invalid amount "${amountRaw}"`);
      continue;
    }

    const description = buildDescription(tx);
    const descData = bankDescription(bank, description, tx.checkNum);
    const sourceKey = buildSourceKey(date, tx, amount);

    if (tx.splits.length > 0) {
      // Split transaction: main account line + one line per split
      const lines: CsvRecord["lines"] = [
        { account: options.mainAccount, currency: "", amount: amount.toString() },
      ];

      let splitSum = 0;
      for (const split of tx.splits) {
        const splitAmount = parseQifAmount(split.amount, european);
        if (splitAmount === null) {
          warnings.push(`Skipped split line with invalid amount "${split.amount}"`);
          continue;
        }
        splitSum += splitAmount;

        const splitAccount = resolveCategory(
          split.category,
          splitAmount,
          options.accountMapping,
          unmappedSet,
        );

        lines.push({
          account: splitAccount,
          currency: "",
          amount: (-splitAmount).toString(),
        });
      }

      // Check if splits balance with total
      const discrepancy = Math.abs(amount - splitSum);
      if (discrepancy > 0.02) {
        // Add balancing line for significant discrepancy
        const balanceAmount = splitSum - amount;
        const balanceAccount = amount > 0 ? INCOME_UNCATEGORIZED : EXPENSES_UNCATEGORIZED;
        lines.push({
          account: balanceAccount,
          currency: "",
          amount: balanceAmount.toString(),
        });
        warnings.push(
          `Split amounts differ from total by ${discrepancy.toFixed(2)} — added balancing line`,
        );
      }

      records.push({
        date,
        description: renderDescription(descData),
        descriptionData: descData,
        lines,
        sourceKey,
      });
    } else {
      // Simple transaction: main account + counter account
      const rule = matchRule(description, options.rules);
      let counterAccount: string;

      if (rule) {
        counterAccount = rule.account;
      } else if (tx.category) {
        counterAccount = resolveCategory(
          tx.category,
          -amount,
          options.accountMapping,
          unmappedSet,
        );
      } else {
        counterAccount = amount > 0 ? INCOME_UNCATEGORIZED : EXPENSES_UNCATEGORIZED;
      }

      records.push({
        date,
        description: renderDescription(descData),
        descriptionData: descData,
        lines: [
          { account: options.mainAccount, currency: "", amount: amount.toString() },
          { account: counterAccount, currency: "", amount: (-amount).toString() },
        ],
        sourceKey,
      });
    }
  }

  const fileHeader: CsvFileHeader = {
    mainAccount: options.mainAccount,
  };

  return {
    records,
    fileHeader,
    warnings,
    unmappedAccounts: [...unmappedSet],
  };
}

/**
 * Suggest a main account name from QIF section account info.
 */
export function suggestQifMainAccount(section: QifSection): string {
  const name = section.account?.name;

  switch (section.type) {
    case "CCard":
      return creditCard(name ?? "QIF");
    case "Bank":
    case "Cash":
      return bankAssets(name ?? "QIF");
    case "Oth A":
      return name ? `Assets:Other:${name}` : "Assets:Other";
    case "Oth L":
      return name ? `Liabilities:Other:${name}` : "Liabilities:Other";
    default:
      return bankAssets(name ?? "QIF");
  }
}
