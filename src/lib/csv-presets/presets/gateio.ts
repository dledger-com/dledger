import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, parsePair, makeTradeLines, makeTradeDescriptionData, makeTransferDescriptionData, makeTransferLines, makeFeeLines } from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

const TRADE_HEADERS = ["create_time", "currency_pair", "side", "amount", "price", "fee", "fee_currency"];
const DEPOSIT_HEADERS = ["timestamp", "amount", "currency", "address", "status", "chain"];
const WITHDRAWAL_HEADERS = ["timestamp", "amount", "fee", "currency", "address", "status", "chain"];

type Variant = "trades" | "deposits" | "withdrawals";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n);

  if (has("currency_pair") && has("side")) return "trades";
  // Withdrawals have "fee" + "currency" + "status" but no "currency_pair"
  // Deposits also have "currency" + "status" but no "fee" as separate column (or withdraw_order_id)
  if (has("currency") && has("status") && has("chain")) {
    // Distinguish deposits from withdrawals by checking for withdraw-specific columns
    if (has("fee") && has("block_number")) return "withdrawals";
    if (has("fee") && has("fail_reason")) return "withdrawals";
    // Deposits may also have withdraw_order_id column but it's empty
    if (has("withdraw_order_id") && !has("fail_reason")) return "deposits";
    return "deposits";
  }
  return null;
}

export const gateioPreset: CsvPreset = {
  id: "gateio",
  name: "Gate.io",
  description: "Gate.io spot trades, deposits, and withdrawals CSV exports.",
  suggestedMainAccount: exchangeAssets("Gateio"),

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
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
  const dateIdx = colIdx(headers, "create_time");
  const pairIdx = colIdx(headers, "currency_pair");
  const sideIdx = colIdx(headers, "side");
  const amtIdx = colIdx(headers, "amount");
  const priceIdx = colIdx(headers, "price");
  const feeIdx = colIdx(headers, "fee");
  const feeCurrIdx = colIdx(headers, "fee_currency");

  if ([dateIdx, pairIdx, sideIdx, amtIdx, priceIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const pair = parsePair(row[pairIdx] ?? "");
    if (!pair) continue;

    const side: "BUY" | "SELL" = (row[sideIdx] ?? "").trim().toLowerCase() === "buy" ? "BUY" : "SELL";
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const price = parseFloat((row[priceIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || isNaN(price) || amount === 0) continue;

    const quoteAmt = amount * price;
    const lines = makeTradeLines("Gateio", pair.base, pair.quote, side, amount, quoteAmt);

    const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
    const feeCurr = feeCurrIdx >= 0 ? (row[feeCurrIdx] ?? "").trim().toUpperCase() : pair.base;
    if (!isNaN(fee) && fee > 0) lines.push(...makeFeeLines("Gateio", feeCurr, fee));

    records.push({ date, description: `Gate.io ${side.toLowerCase()} ${pair.base}/${pair.quote}`, descriptionData: makeTradeDescriptionData("Gate.io", pair.base, pair.quote, side), lines });
  }

  return records;
}

function transformDeposits(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "timestamp");
  const amtIdx = colIdx(headers, "amount");
  const currIdx = colIdx(headers, "currency");
  const statusIdx = colIdx(headers, "status");

  if ([dateIdx, amtIdx, currIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    if (statusIdx >= 0 && (row[statusIdx] ?? "").trim().toUpperCase() !== "DONE") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const lines = makeTransferLines("Gateio", currency, amount);
    records.push({ date, description: `Gate.io deposit: ${currency}`, descriptionData: makeTransferDescriptionData("Gate.io", currency, "deposit"), lines });
  }

  return records;
}

function transformWithdrawals(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "timestamp");
  const amtIdx = colIdx(headers, "amount");
  const feeIdx = colIdx(headers, "fee");
  const currIdx = colIdx(headers, "currency");
  const statusIdx = colIdx(headers, "status");

  if ([dateIdx, amtIdx, currIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    if (statusIdx >= 0) {
      const status = (row[statusIdx] ?? "").trim().toUpperCase();
      if (status === "CANCEL" || status === "CANCELLED") continue;
    }

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const lines = makeTransferLines("Gateio", currency, -amount);

    const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
    if (!isNaN(fee) && fee > 0) lines.push(...makeFeeLines("Gateio", currency, fee));

    records.push({ date, description: `Gate.io withdrawal: ${currency}`, descriptionData: makeTransferDescriptionData("Gate.io", currency, "withdrawal"), lines });
  }

  return records;
}
