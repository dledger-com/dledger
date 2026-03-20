import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx, makeTransferLines, makeTransferDescriptionData } from "./shared.js";
import {
  exchangeAssets,
  exchangeAssetsCurrency,
  exchangeIncome,
  EQUITY_EXTERNAL,
} from "$lib/accounts/paths.js";

const REQUIRED_HEADERS = ["Date", "Amount", "Currency", "Type", "Status"];

function parseYieldDate(raw: string): string | null {
  // "11-07-2022 14:23:23 UTC" → DD-MM-YYYY → YYYY-MM-DD
  const cleaned = raw.trim().replace(/\s*UTC\s*$/i, "");
  const m = cleaned.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, day, month, year] = m;
  return `${year}-${month}-${day}`;
}

export const yieldAppPreset: CsvPreset = {
  id: "yield-app",
  name: "Yield App",
  description: "Yield App full transaction history CSV.",
  suggestedMainAccount: exchangeAssets("YieldApp"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = REQUIRED_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    // Also check for Yield-specific columns
    const hasYieldSpecific = lower.includes("rewarded from") || lower.includes("fund price") || lower.includes("yld price");
    if (matched >= 4 && hasYieldSpecific) return 90;
    return matched >= 5 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const dateIdx = colIdx(headers, "Date");
    const amtIdx = colIdx(headers, "Amount");
    const currIdx = colIdx(headers, "Currency");
    const typeIdx = colIdx(headers, "Type");
    const statusIdx = colIdx(headers, "Status");

    if ([dateIdx, amtIdx, currIdx, typeIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      // Filter by status
      if (statusIdx >= 0) {
        const status = (row[statusIdx] ?? "").trim().toLowerCase();
        if (status !== "succeeded" && status !== "confirmed") continue;
      }

      const date = parseYieldDate(row[dateIdx] ?? "");
      if (!date) continue;

      const currency = (row[currIdx] ?? "").trim().toUpperCase();
      const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
      if (!currency || isNaN(amount) || amount === 0) continue;

      const type = (row[typeIdx] ?? "").trim().toLowerCase();
      const lines: CsvRecord["lines"] = [];

      if (type === "interest" || type === "referral reward" || type === "bonus" || type === "reward") {
        // Income
        const incomeLabel =
          type === "interest" ? "Interest" :
          type === "referral reward" ? "Referral" :
          type === "bonus" ? "Bonus" : "Rewards";
        lines.push(
          { account: exchangeAssetsCurrency("YieldApp", currency), currency, amount: amount.toString() },
          { account: exchangeIncome("YieldApp", incomeLabel), currency, amount: (-amount).toString() },
        );
        const kind = type === "referral reward" ? "referral"
          : type === "reward" ? "general"
          : type;
        const rewardDescData = { type: "cex-reward" as const, exchange: "Yield App", kind, currency };
        records.push({ date, description: renderDescription(rewardDescData), descriptionData: rewardDescData, lines });
      } else if (type === "withdrawal") {
        // Withdrawal: amount is positive in data, negate for outflow
        lines.push(...makeTransferLines("YieldApp", currency, -amount));
        const wdDescData = makeTransferDescriptionData("Yield App", currency, "withdrawal");
        records.push({ date, description: renderDescription(wdDescData), descriptionData: wdDescData, lines });
      } else if (type === "deposit") {
        lines.push(...makeTransferLines("YieldApp", currency, amount));
        const depDescData = makeTransferDescriptionData("Yield App", currency, "deposit");
        records.push({ date, description: renderDescription(depDescData), descriptionData: depDescData, lines });
      } else if (type === "redeem" || type === "redemption") {
        // Redeem: receiving capital back
        lines.push(...makeTransferLines("YieldApp", currency, amount));
        const redeemDescData = { type: "cex-operation" as const, exchange: "Yield App", operation: "redeem", currency };
        records.push({ date, description: renderDescription(redeemDescData), descriptionData: redeemDescData, lines });
      } else {
        // Fallback
        lines.push(
          { account: exchangeAssetsCurrency("YieldApp", currency), currency, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency, amount: (-amount).toString() },
        );
        const fallbackDescData = { type: "cex-operation" as const, exchange: "Yield App", operation: type, currency };
        records.push({ date, description: renderDescription(fallbackDescData), descriptionData: fallbackDescData, lines });
      }
    }

    return records;
  },
};
