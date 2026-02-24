import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, parseNamedMonthDate } from "./shared.js";

const REQUIRED_HEADERS = ["Date", "Description", "Asset", "Amount", "Balance"];

export const coinlistPreset: CsvPreset = {
  id: "coinlist",
  name: "CoinList",
  description: "CoinList wallet transaction statement CSV.",
  suggestedMainAccount: "Assets:Exchanges:CoinList",

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

      if (descLower.includes("staking reward")) {
        lines.push(
          { account: `Assets:Exchanges:CoinList:${asset}`, currency: asset, amount: amount.toString() },
          { account: "Income:Exchanges:CoinList:Staking", currency: asset, amount: (-amount).toString() },
        );
      } else if (descLower.startsWith("sold ")) {
        // Trade: paired rows balance via Equity:Trading
        lines.push(
          { account: `Assets:Exchanges:CoinList:${asset}`, currency: asset, amount: amount.toString() },
          { account: "Equity:Trading", currency: asset, amount: (-amount).toString() },
        );
      } else if (descLower.includes("deposit")) {
        lines.push(
          { account: `Assets:Exchanges:CoinList:${asset}`, currency: asset, amount: amount.toString() },
          { account: "Equity:External", currency: asset, amount: (-amount).toString() },
        );
      } else if (descLower.includes("withdrawal")) {
        lines.push(
          { account: `Assets:Exchanges:CoinList:${asset}`, currency: asset, amount: amount.toString() },
          { account: "Equity:External", currency: asset, amount: (-amount).toString() },
        );
      } else {
        // Hold, Release, and other types → transfer
        lines.push(
          { account: `Assets:Exchanges:CoinList:${asset}`, currency: asset, amount: amount.toString() },
          { account: "Equity:External", currency: asset, amount: (-amount).toString() },
        );
      }

      records.push({ date, description: `CoinList: ${desc.slice(0, 80)}`, lines });
    }

    return records;
  },
};
