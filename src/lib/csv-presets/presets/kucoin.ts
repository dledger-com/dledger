import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { renderDescription } from "$lib/types/description-data.js";
import {
  colIdx,
  makeTradeLines,
  makeTradeDescriptionData,
  makeTransferLines,
  makeTransferDescriptionData,
  makeFeeLines,
} from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

type Variant = "spot-splitting" | "spot-nonsplitting" | "deposits" | "withdrawals";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n.toLowerCase());

  // Gate: all KuCoin CSVs have UID + Account Type
  if (!has("uid") || !has("account type")) return null;

  // spot-splitting: has Symbol + Filled Amount + Avg. Filled Price, no Order Price
  if (has("symbol") && has("filled amount") && has("avg. filled price") && !has("order price")) {
    return "spot-splitting";
  }
  // spot-nonsplitting: has Symbol + Order Price + Status
  if (has("symbol") && has("order price") && has("status")) {
    return "spot-nonsplitting";
  }
  // withdrawals: has Coin + Withdrawal Address/Account
  if (has("coin") && has("withdrawal address/account")) {
    return "withdrawals";
  }
  // deposits: has Coin + Amount + Status, no Withdrawal Address/Account
  if (has("coin") && has("amount") && has("status") && !has("withdrawal address/account")) {
    return "deposits";
  }

  return null;
}

/** Parse KuCoin pair (uses `-` separator, e.g. `RHOC-BTC`) */
function parseKuCoinPair(symbol: string): { base: string; quote: string } | null {
  const parts = symbol.trim().toUpperCase().split("-");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { base: parts[0], quote: parts[1] };
}

/** Find column index by prefix (KuCoin embeds timezone in header, e.g. "Filled Time(UTC+02:00)") */
function findTimeCol(headers: string[], prefix: string): number {
  const lowerPrefix = prefix.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].trim().toLowerCase().startsWith(lowerPrefix)) return i;
  }
  return -1;
}

function extractDate(raw: string): string | null {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Parse amount, treating "null" and empty strings as 0 */
function parseAmt(raw: string | undefined): number {
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "null") return 0;
  const v = parseFloat(raw.replace(/,/g, ""));
  return isNaN(v) ? 0 : v;
}

export const kucoinPreset: CsvPreset = {
  id: "kucoin",
  name: "KuCoin",
  description: "KuCoin spot trades, deposits, and withdrawals CSV exports.",
  suggestedMainAccount: exchangeAssets("KuCoin"),

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    if (variant === "spot-splitting") return transformSpotSplitting(headers, rows);
    if (variant === "spot-nonsplitting") return transformSpotNonSplitting(headers, rows);
    if (variant === "deposits") return transformDeposits(headers, rows);
    return transformWithdrawals(headers, rows);
  },
};

interface AggregatedOrder {
  symbol: string;
  side: string;
  baseSum: number;
  quoteSum: number;
  feeSum: number;
  feeCurrency: string;
  lastDate: string;
}

function transformSpotSplitting(headers: string[], rows: string[][]): CsvRecord[] {
  const orderIdIdx = colIdx(headers, "Order ID");
  const symbolIdx = colIdx(headers, "Symbol");
  const sideIdx = colIdx(headers, "Side");
  const filledAmtIdx = colIdx(headers, "Filled Amount");
  const filledVolIdx = colIdx(headers, "Filled Volume");
  const feeIdx = colIdx(headers, "Fee");
  const feeCurrIdx = colIdx(headers, "Fee Currency");
  const timeIdx = findTimeCol(headers, "Filled Time");

  if ([orderIdIdx, symbolIdx, sideIdx, filledAmtIdx, filledVolIdx, timeIdx].some((i) => i === -1)) {
    return [];
  }

  // Group rows by Order ID
  const orders = new Map<string, AggregatedOrder>();

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const orderId = (row[orderIdIdx] ?? "").trim();
    if (!orderId) continue;

    const date = extractDate(row[timeIdx] ?? "");
    if (!date) continue;

    const baseAmt = parseAmt(row[filledAmtIdx]);
    const quoteAmt = parseAmt(row[filledVolIdx]);
    const fee = parseAmt(row[feeIdx]);

    let feeCurr = feeCurrIdx >= 0 ? (row[feeCurrIdx] ?? "").trim().toUpperCase() : "";

    const existing = orders.get(orderId);
    if (existing) {
      existing.baseSum += baseAmt;
      existing.quoteSum += quoteAmt;
      existing.feeSum += fee;
      existing.lastDate = date;
      if (feeCurr) existing.feeCurrency = feeCurr;
    } else {
      const symbol = (row[symbolIdx] ?? "").trim();
      const side = (row[sideIdx] ?? "").trim().toUpperCase();

      // Infer fee currency from side if not provided
      if (!feeCurr) {
        const pair = parseKuCoinPair(symbol);
        if (pair) {
          feeCurr = side === "BUY" ? pair.base : pair.quote;
        }
      }

      orders.set(orderId, {
        symbol,
        side,
        baseSum: baseAmt,
        quoteSum: quoteAmt,
        feeSum: fee,
        feeCurrency: feeCurr,
        lastDate: date,
      });
    }
  }

  const records: CsvRecord[] = [];

  for (const [orderId, order] of orders) {
    const pair = parseKuCoinPair(order.symbol);
    if (!pair) continue;

    const side = order.side as "BUY" | "SELL";
    if (side !== "BUY" && side !== "SELL") continue;

    const lines = makeTradeLines("KuCoin", pair.base, pair.quote, side, order.baseSum, order.quoteSum);

    if (order.feeSum > 0) {
      lines.push(...makeFeeLines("KuCoin", order.feeCurrency, order.feeSum));
    }

    const descData = makeTradeDescriptionData("KuCoin", pair.base, pair.quote, side);
    records.push({
      date: order.lastDate,
      description: renderDescription(descData),
      descriptionData: descData,
      lines,
      sourceKey: orderId,
      groupKey: orderId,
    });
  }

  return records;
}

function transformSpotNonSplitting(headers: string[], rows: string[][]): CsvRecord[] {
  const orderIdIdx = colIdx(headers, "Order ID");
  const symbolIdx = colIdx(headers, "Symbol");
  const sideIdx = colIdx(headers, "Side");
  const filledAmtIdx = colIdx(headers, "Filled Amount");
  const filledVolIdx = colIdx(headers, "Filled Volume");
  const feeIdx = colIdx(headers, "Fee");
  const feeCurrIdx = colIdx(headers, "Fee Currency");
  const statusIdx = colIdx(headers, "Status");
  const timeIdx = findTimeCol(headers, "Filled Time");

  if ([symbolIdx, sideIdx, filledAmtIdx, filledVolIdx, timeIdx].some((i) => i === -1)) {
    return [];
  }

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const filledAmt = parseAmt(row[filledAmtIdx]);
    if (filledAmt === 0) continue; // Skip cancelled/unfilled

    // Skip non-done statuses if status column exists
    if (statusIdx >= 0) {
      const status = (row[statusIdx] ?? "").trim().toLowerCase();
      if (status && status !== "done") continue;
    }

    const date = extractDate(row[timeIdx] ?? "");
    if (!date) continue;

    const pair = parseKuCoinPair((row[symbolIdx] ?? "").trim());
    if (!pair) continue;

    const side = (row[sideIdx] ?? "").trim().toUpperCase() as "BUY" | "SELL";
    if (side !== "BUY" && side !== "SELL") continue;

    const filledVol = parseAmt(row[filledVolIdx]);
    const fee = parseAmt(row[feeIdx]);

    let feeCurr = feeCurrIdx >= 0 ? (row[feeCurrIdx] ?? "").trim().toUpperCase() : "";
    if (!feeCurr) {
      feeCurr = side === "BUY" ? pair.base : pair.quote;
    }

    const lines = makeTradeLines("KuCoin", pair.base, pair.quote, side, filledAmt, filledVol);

    if (fee > 0) {
      lines.push(...makeFeeLines("KuCoin", feeCurr, fee));
    }

    const orderId = orderIdIdx >= 0 ? (row[orderIdIdx] ?? "").trim() : undefined;
    const descData = makeTradeDescriptionData("KuCoin", pair.base, pair.quote, side);
    records.push({
      date: date,
      description: renderDescription(descData),
      descriptionData: descData,
      lines,
      sourceKey: orderId || undefined,
      groupKey: orderId || undefined,
    });
  }

  return records;
}

function transformDeposits(headers: string[], rows: string[][]): CsvRecord[] {
  const coinIdx = colIdx(headers, "Coin");
  const amountIdx = colIdx(headers, "Amount");
  const statusIdx = colIdx(headers, "Status");
  const feeIdx = colIdx(headers, "Fee");
  const timeIdx = findTimeCol(headers, "Time");

  if ([coinIdx, amountIdx, statusIdx, timeIdx].some((i) => i === -1)) {
    return [];
  }

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const status = (row[statusIdx] ?? "").trim().toUpperCase();
    if (status !== "SUCCESS") continue;

    const date = extractDate(row[timeIdx] ?? "");
    if (!date) continue;

    const currency = (row[coinIdx] ?? "").trim().toUpperCase();
    if (!currency) continue;

    const amount = parseAmt(row[amountIdx]);
    if (amount === 0) continue;

    const lines = makeTransferLines("KuCoin", currency, amount);

    const fee = parseAmt(row[feeIdx]);
    if (fee > 0) lines.push(...makeFeeLines("KuCoin", currency, fee));

    const descData = makeTransferDescriptionData("KuCoin", currency, "deposit");
    records.push({
      date,
      description: renderDescription(descData),
      descriptionData: descData,
      lines,
    });
  }

  return records;
}

function transformWithdrawals(headers: string[], rows: string[][]): CsvRecord[] {
  const coinIdx = colIdx(headers, "Coin");
  const amountIdx = colIdx(headers, "Amount");
  const statusIdx = colIdx(headers, "Status");
  const feeIdx = colIdx(headers, "Fee");
  const timeIdx = findTimeCol(headers, "Time");

  if ([coinIdx, amountIdx, statusIdx, timeIdx].some((i) => i === -1)) {
    return [];
  }

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const status = (row[statusIdx] ?? "").trim().toUpperCase();
    if (status !== "SUCCESS") continue;

    const date = extractDate(row[timeIdx] ?? "");
    if (!date) continue;

    const currency = (row[coinIdx] ?? "").trim().toUpperCase();
    if (!currency) continue;

    const amount = parseAmt(row[amountIdx]);
    if (amount === 0) continue;

    const lines = makeTransferLines("KuCoin", currency, -amount);

    const fee = parseAmt(row[feeIdx]);
    if (fee > 0) lines.push(...makeFeeLines("KuCoin", currency, fee));

    const descData = makeTransferDescriptionData("KuCoin", currency, "withdrawal");
    records.push({
      date,
      description: renderDescription(descData),
      descriptionData: descData,
      lines,
    });
  }

  return records;
}
