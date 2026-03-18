import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, parsePair, makeTradeLines, makeTradeDescription, makeTransferLines, makeFeeLines } from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

const TRADE_HEADERS = ["Date", "Market", "Category", "Type", "Price", "Amount", "Total", "Fee", "Order Number"];
const DEPOSIT_HEADERS = ["depositNumber", "currency", "address", "amount", "txid", "timestamp", "status"];
const WITHDRAWAL_HEADERS = ["withdrawalRequestsId", "currency", "address", "amount", "fee", "timestamp", "status"];

type Variant = "trades" | "deposits" | "withdrawals";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n.toLowerCase());

  // Trades: unique "Category" header
  if (has("Category") && has("Market") && has("Type")) return "trades";
  // Deposits: unique "depositNumber"
  if (has("depositNumber")) return "deposits";
  // Withdrawals: unique "withdrawalRequestsId"
  if (has("withdrawalRequestsId")) return "withdrawals";
  return null;
}

export const poloniexPreset: CsvPreset = {
  id: "poloniex",
  name: "Poloniex",
  description: "Poloniex trade history, deposits, and withdrawals CSV exports.",
  suggestedMainAccount: exchangeAssets("Poloniex"),

  detect(headers: string[]): number {
    const variant = detectVariant(headers);
    if (!variant) return 0;
    // Deposits/withdrawals have unique Poloniex-specific ID columns → higher confidence
    return variant === "trades" ? 85 : 90;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    if (variant === "trades") return transformTrades(headers, rows);
    if (variant === "deposits") return transformDeposits(headers, rows);
    return transformWithdrawals(headers, rows);
  },
};

function extractDate(raw: string): string | null {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function transformTrades(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "Date");
  const marketIdx = colIdx(headers, "Market");
  const typeIdx = colIdx(headers, "Type");
  const amtIdx = colIdx(headers, "Amount");
  const totalIdx = colIdx(headers, "Total");
  const feeIdx = colIdx(headers, "Fee");

  if ([dateIdx, marketIdx, typeIdx, amtIdx, totalIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const pair = parsePair(row[marketIdx] ?? "");
    if (!pair) continue;

    const side: "BUY" | "SELL" = (row[typeIdx] ?? "").trim().toUpperCase() === "BUY" ? "BUY" : "SELL";
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const total = parseFloat((row[totalIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || isNaN(total) || amount === 0) continue;

    const lines = makeTradeLines("Poloniex", pair.base, pair.quote, side, amount, total);

    // Fee is percentage string like "0.25%"
    if (feeIdx >= 0) {
      const feeStr = (row[feeIdx] ?? "").trim().replace("%", "");
      const feePct = parseFloat(feeStr);
      if (!isNaN(feePct) && feePct > 0) {
        const pctFrac = feePct / 100;
        if (side === "SELL") {
          // Fee on received quote
          const feeAmt = total * pctFrac;
          lines.push(...makeFeeLines("Poloniex", pair.quote, feeAmt));
        } else {
          // Fee on received base
          const feeAmt = amount * pctFrac;
          lines.push(...makeFeeLines("Poloniex", pair.base, feeAmt));
        }
      }
    }

    records.push({ date, description: makeTradeDescription("Poloniex", pair.base, pair.quote, side), lines });
  }

  return records;
}

function transformDeposits(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "timestamp");
  const currIdx = colIdx(headers, "currency");
  const amtIdx = colIdx(headers, "amount");
  const statusIdx = colIdx(headers, "status");

  const idIdx = colIdx(headers, "depositNumber");

  if ([dateIdx, currIdx, amtIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    if (statusIdx >= 0 && (row[statusIdx] ?? "").trim().toUpperCase() !== "COMPLETED") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const lines = makeTransferLines("Poloniex", currency, amount);
    const sourceKey = idIdx >= 0 ? (row[idIdx] ?? "").trim() : undefined;
    records.push({ date, description: `Poloniex deposit: ${currency}`, lines, sourceKey });
  }

  return records;
}

function transformWithdrawals(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "timestamp");
  const currIdx = colIdx(headers, "currency");
  const amtIdx = colIdx(headers, "amount");
  const feeIdx = colIdx(headers, "fee");
  const statusIdx = colIdx(headers, "status");

  const idIdx = colIdx(headers, "withdrawalRequestsId");

  if ([dateIdx, currIdx, amtIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    if (statusIdx >= 0 && (row[statusIdx] ?? "").trim().toUpperCase() !== "COMPLETED") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const lines = makeTransferLines("Poloniex", currency, -amount);

    const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
    if (!isNaN(fee) && fee > 0) lines.push(...makeFeeLines("Poloniex", currency, fee));

    const sourceKey = idIdx >= 0 ? (row[idIdx] ?? "").trim() : undefined;
    records.push({ date, description: `Poloniex withdrawal: ${currency}`, lines, sourceKey });
  }

  return records;
}
