import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import type { DescriptionData } from "$lib/types/description-data.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx, parseNamedMonthDate, makeTransferDescriptionData } from "./shared.js";
import {
  exchangeAssets,
  exchangeAssetsCurrency,
  exchangeIncome,
  EQUITY_EXTERNAL,
} from "$lib/accounts/paths.js";

const DETECT_HEADERS = [
  "Internal id", "Transaction type", "Coin type", "Coin amount", "USD Value",
];

export const celsiusPreset: CsvPreset = {
  id: "celsius",
  name: "Celsius",
  description: "Celsius Network transaction export CSV.",
  suggestedMainAccount: exchangeAssets("Celsius"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = DETECT_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    return matched >= 4 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date and time", dateFormat: "named-month" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const idIdx = colIdx(headers, "Internal id");
    const dateIdx = colIdx(headers, "Date and time");
    const typeIdx = colIdx(headers, "Transaction type");
    const coinIdx = colIdx(headers, "Coin type");
    const amtIdx = colIdx(headers, "Coin amount");
    const usdIdx = colIdx(headers, "USD Value");
    const origCoinIdx = colIdx(headers, "Original Reward Coin");
    const origAmtIdx = colIdx(headers, "Reward Amount In Original Coin");

    if ([dateIdx, typeIdx, coinIdx, amtIdx].some((i) => i === -1)) {
      return null;
    }

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const rawDate = (row[dateIdx] ?? "").trim();
      const date = parseNamedMonthDate(rawDate);
      if (!date) continue;

      const txType = (row[typeIdx] ?? "").trim();
      const coin = (row[coinIdx] ?? "").trim().toUpperCase();
      const rawAmt = (row[amtIdx] ?? "").replace(/[$,]/g, "").trim();
      const amountNum = parseFloat(rawAmt);
      if (!coin || !rawAmt || isNaN(amountNum) || amountNum === 0) continue;

      const usdValue = (row[usdIdx] ?? "").trim();
      const origCoin = origCoinIdx >= 0 ? (row[origCoinIdx] ?? "").trim().toUpperCase() : "";
      const origAmt = origAmtIdx >= 0 ? (row[origAmtIdx] ?? "").trim() : "";
      const sourceKey = idIdx >= 0 ? (row[idIdx] ?? "").trim() : undefined;

      const metadata: Record<string, string> = {};
      if (usdValue) metadata["usd_value"] = usdValue;
      if (origCoin) metadata["original_reward_coin"] = origCoin;
      if (origAmt) metadata["original_reward_amount"] = origAmt;

      const lines: CsvRecord["lines"] = [];

      if (txType === "Reward" || txType === "Promo Code Reward") {
        const kind = txType === "Promo Code Reward" ? "promo" : "interest";
        const incomeAccount = txType === "Promo Code Reward"
          ? exchangeIncome("Celsius", "Promo")
          : exchangeIncome("Celsius", "Rewards");

        lines.push(
          { account: exchangeAssetsCurrency("Celsius", coin), currency: coin, amount: amountNum.toString() },
          { account: incomeAccount, currency: coin, amount: (-amountNum).toString() },
        );

        const descData: DescriptionData = { type: "cex-reward", exchange: "Celsius", kind, currency: coin };
        records.push({
          date,
          description: renderDescription(descData),
          descriptionData: descData,
          lines,
          sourceKey,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      } else if (txType === "Transfer") {
        lines.push(
          { account: exchangeAssetsCurrency("Celsius", coin), currency: coin, amount: amountNum.toString() },
          { account: EQUITY_EXTERNAL, currency: coin, amount: (-amountNum).toString() },
        );

        const descData = makeTransferDescriptionData("Celsius", coin, "deposit");
        records.push({
          date,
          description: renderDescription(descData),
          descriptionData: descData,
          lines,
          sourceKey,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      } else {
        // Fallback for unknown types
        lines.push(
          { account: exchangeAssetsCurrency("Celsius", coin), currency: coin, amount: amountNum.toString() },
          { account: exchangeIncome("Celsius", txType), currency: coin, amount: (-amountNum).toString() },
        );

        const descData: DescriptionData = { type: "cex-operation", exchange: "Celsius", operation: txType.toLowerCase(), currency: coin };
        records.push({
          date,
          description: renderDescription(descData),
          descriptionData: descData,
          lines,
          sourceKey,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }
    }

    return records;
  },
};
