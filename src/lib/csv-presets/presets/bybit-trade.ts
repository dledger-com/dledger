import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parsePair, makeTradeDescription } from "./shared.js";
import { exchangeAssets, exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING } from "$lib/accounts/paths.js";

const REQUIRED_HEADERS_V1 = ["Date", "Pair", "Side", "Avg. Price", "Filled", "Total", "Fee"];
const REQUIRED_HEADERS_V2 = ["Date", "Symbol", "Side", "Avg. Price", "Qty", "Total", "Fee"];

export const bybitTradePreset: CsvPreset = {
  id: "bybit-trade",
  name: "Bybit Trade History",
  description: "Bybit spot trade history CSV with Date, Pair/Symbol, Side, Avg. Price, Filled/Qty, Total, Fee.",
  suggestedMainAccount: exchangeAssets("Bybit"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const v1Match = REQUIRED_HEADERS_V1.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length / REQUIRED_HEADERS_V1.length;
    const v2Match = REQUIRED_HEADERS_V2.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length / REQUIRED_HEADERS_V2.length;
    const bestMatch = Math.max(v1Match, v2Match);
    return bestMatch >= 0.75 ? 85 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    return {
      dateColumn: "Date",
      dateFormat: "ISO8601",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    const dateIdx = col("Date");
    const pairIdx = col("Pair") >= 0 ? col("Pair") : col("Symbol");
    const sideIdx = col("Side");
    const filledIdx = col("Filled") >= 0 ? col("Filled") : col("Qty");
    const totalIdx = col("Total");
    const feeIdx = col("Fee");
    const feeCoinIdx = col("Fee Coin");

    if ([dateIdx, pairIdx, sideIdx, filledIdx, totalIdx].some((i) => i === -1)) {
      return null;
    }

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const dateMatch = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      const pair = parsePair(row[pairIdx] ?? "");
      if (!pair) continue;

      const side = (row[sideIdx] ?? "").trim().toUpperCase();
      const filled = parseFloat((row[filledIdx] ?? "").replace(/,/g, ""));
      const total = parseFloat((row[totalIdx] ?? "").replace(/,/g, ""));

      if (isNaN(filled) || isNaN(total) || filled === 0) continue;

      const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
      const feeCoin = feeCoinIdx >= 0 ? (row[feeCoinIdx] ?? "").trim().toUpperCase() : pair.quote;

      const lines: CsvRecord["lines"] = [];

      if (side === "BUY") {
        // Buy: spend quote, receive base → quote line first
        lines.push(
          { account: exchangeAssetsCurrency("Bybit", pair.quote), currency: pair.quote, amount: (-total).toString() },
          { account: exchangeAssetsCurrency("Bybit", pair.base), currency: pair.base, amount: filled.toString() },
        );
      } else {
        lines.push(
          { account: exchangeAssetsCurrency("Bybit", pair.base), currency: pair.base, amount: (-filled).toString() },
          { account: exchangeAssetsCurrency("Bybit", pair.quote), currency: pair.quote, amount: total.toString() },
        );
      }

      // Balance with Equity:Trading
      for (const l of [...lines]) {
        lines.push({
          account: EQUITY_TRADING,
          currency: l.currency,
          amount: (-parseFloat(l.amount)).toString(),
        });
      }

      // Fee
      if (!isNaN(fee) && fee > 0) {
        lines.push(
          { account: exchangeFees("Bybit"), currency: feeCoin, amount: fee.toString() },
          { account: exchangeAssetsCurrency("Bybit", feeCoin), currency: feeCoin, amount: (-fee).toString() },
        );
      }

      records.push({
        date,
        description: makeTradeDescription("Bybit", pair.base, pair.quote, side as "BUY" | "SELL"),
        lines,
      });
    }

    return records;
  },
};
