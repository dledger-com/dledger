import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import type { DescriptionData } from "$lib/types/description-data.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx, parseNamedMonthDate, makeTransferDescriptionData } from "./shared.js";
import { exchangeAssets, exchangeAssetsCurrency, exchangeFees, exchangeStaking, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const REQUIRED_HEADERS = ["Date", "Description", "Asset", "Amount", "Balance"];

export const coinlistPreset: CsvPreset = {
  id: "coinlist",
  name: "CoinList",
  description: "CoinList wallet transaction statement CSV.",
  suggestedMainAccount: exchangeAssets("CoinList"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = REQUIRED_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    return matched >= 4 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const dateIdx = colIdx(headers, "Date");
    const descIdx = colIdx(headers, "Description");
    const assetIdx = colIdx(headers, "Asset");
    const amtIdx = colIdx(headers, "Amount");

    if ([dateIdx, descIdx, assetIdx, amtIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const date = parseNamedMonthDate(row[dateIdx] ?? "");
      if (!date) continue;

      const desc = (row[descIdx] ?? "").trim();
      const asset = (row[assetIdx] ?? "").trim().toUpperCase();
      const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
      if (!asset || isNaN(amount) || amount === 0) continue;

      const descLower = desc.toLowerCase();
      const lines: CsvRecord["lines"] = [];

      let descData: DescriptionData;
      if (descLower.includes("staking reward")) {
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: exchangeStaking("CoinList"), currency: asset, amount: (-amount).toString() },
        );
        descData = { type: "cex-reward", exchange: "CoinList", kind: "staking", currency: asset };
      } else if (descLower.startsWith("sold ") || descLower.startsWith("bought ")) {
        // Trade: paired rows balance via Equity:Trading, groupKey merges both legs
        // Parse trade description to extract both currencies
        const tradeMatch = desc.match(/^(?:Sold|Bought)\s+[\d.,]+\s+(\w+)\s+for\s+[\d.,]+\s+(\w+)/i);
        let spent: string;
        let received: string;
        if (descLower.startsWith("sold ")) {
          spent = tradeMatch ? tradeMatch[1].toUpperCase() : asset;
          received = tradeMatch ? tradeMatch[2].toUpperCase() : "";
        } else {
          spent = tradeMatch ? tradeMatch[2].toUpperCase() : "";
          received = tradeMatch ? tradeMatch[1].toUpperCase() : asset;
        }
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: EQUITY_TRADING, currency: asset, amount: (-amount).toString() },
        );
        descData = { type: "cex-trade", exchange: "CoinList", spent, received };
        records.push({ date, description: renderDescription(descData), descriptionData: descData, lines, groupKey: `${date}|${desc}` });
        continue;
      } else if (descLower.includes("deposit")) {
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency: asset, amount: (-amount).toString() },
        );
        descData = makeTransferDescriptionData("CoinList", asset, "deposit");
      } else if (descLower.includes("withdrawal")) {
        // Extract fee from description: "Withdrawal of 945.15 USDC to 0x...• Fee 54.85 USDC"
        const feeMatch = desc.match(/[•·]\s*Fee\s+([\d.,]+)\s*(\w+)/i);
        if (feeMatch) {
          const feeAmt = parseFloat(feeMatch[1].replace(/,/g, ""));
          if (!isNaN(feeAmt) && feeAmt > 0) {
            // amount is negative (e.g., -1000), feeAmt is positive (e.g., 54.85)
            // Net withdrawal = |amount| - feeAmt (e.g., 945.15)
            const netAmount = -(amount + feeAmt); // amount is negative, so this is positive
            lines.push(
              { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
              { account: EQUITY_EXTERNAL, currency: asset, amount: netAmount.toString() },
              { account: exchangeFees("CoinList"), currency: asset, amount: feeAmt.toString() },
            );
            descData = makeTransferDescriptionData("CoinList", asset, "withdrawal");
            records.push({ date, description: renderDescription(descData), descriptionData: descData, lines });
            continue;
          }
        }
        // No fee found — standard 2-line pattern
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency: asset, amount: (-amount).toString() },
        );
        descData = makeTransferDescriptionData("CoinList", asset, "withdrawal");
      } else if (descLower.includes("distribution")) {
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency: asset, amount: (-amount).toString() },
        );
        descData = { type: "cex-operation", exchange: "CoinList", operation: "distribution", currency: asset };
      } else {
        // Hold, Release, and other types → operation
        const operation = descLower.split(" ")[0];
        lines.push(
          { account: exchangeAssetsCurrency("CoinList", asset), currency: asset, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency: asset, amount: (-amount).toString() },
        );
        descData = { type: "cex-operation", exchange: "CoinList", operation, currency: asset };
      }

      records.push({ date, description: renderDescription(descData), descriptionData: descData, lines });
    }

    return records;
  },
};
