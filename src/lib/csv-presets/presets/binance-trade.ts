import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { parsePair } from "./shared.js";

// Binance trade history headers (spot trade)
const REQUIRED_HEADERS_V1 = ["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"];
const REQUIRED_HEADERS_V2 = ["Date(UTC)", "Market", "Side", "Price", "Amount", "Total", "Fee", "Fee Coin"];

export const binanceTradePreset: CsvPreset = {
  id: "binance-trade",
  name: "Binance Trade History",
  description: "Binance spot trade history CSV with Date(UTC), Pair/Market, Side, Price, Filled/Amount, Total, Fee.",
  suggestedMainAccount: "Assets:Exchanges:Binance",

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const v1Match = REQUIRED_HEADERS_V1.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    const v2Match = REQUIRED_HEADERS_V2.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    const bestMatch = Math.max(v1Match / REQUIRED_HEADERS_V1.length, v2Match / REQUIRED_HEADERS_V2.length);
    return bestMatch >= 0.75 ? 85 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    return {
      dateColumn: "Date(UTC)",
      dateFormat: "ISO8601",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    const dateIdx = col("Date(UTC)");
    const pairIdx = col("Pair") >= 0 ? col("Pair") : col("Market");
    const sideIdx = col("Side");
    const filledIdx = col("Filled") >= 0 ? col("Filled") : col("Amount");
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
        // Buy: receive base, spend quote
        lines.push(
          { account: `Assets:Exchanges:Binance:${pair.base}`, currency: pair.base, amount: filled.toString() },
          { account: `Assets:Exchanges:Binance:${pair.quote}`, currency: pair.quote, amount: (-total).toString() },
        );
      } else {
        // Sell: spend base, receive quote
        lines.push(
          { account: `Assets:Exchanges:Binance:${pair.base}`, currency: pair.base, amount: (-filled).toString() },
          { account: `Assets:Exchanges:Binance:${pair.quote}`, currency: pair.quote, amount: total.toString() },
        );
      }

      // Balance with Equity:Trading
      for (const l of [...lines]) {
        lines.push({
          account: "Equity:Trading",
          currency: l.currency,
          amount: (-parseFloat(l.amount)).toString(),
        });
      }

      // Fee
      if (!isNaN(fee) && fee > 0) {
        lines.push(
          { account: "Expenses:Exchanges:Binance:Fees", currency: feeCoin, amount: fee.toString() },
          { account: `Assets:Exchanges:Binance:${feeCoin}`, currency: feeCoin, amount: (-fee).toString() },
        );
      }

      records.push({
        date,
        description: `Binance ${side.toLowerCase()} ${pair.base}/${pair.quote}`,
        lines,
      });
    }

    return records;
  },
};
