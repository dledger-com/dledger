import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, parseNamedMonthDate, makeTradeLines, makeTransferLines, makeFeeLines } from "./shared.js";

const TRADE_HEADERS = ["Trade ID", "Date/Time", "Market", "Price", "Amount in BTC", "Offer type", "Status"];
const TX_HEADERS = ["Date/Time", "Details", "Transaction ID", "Amount in BTC"];

function parseEurNum(raw: string): number {
  const s = raw.trim();
  if (s.includes(",") && !s.includes(".")) return parseFloat(s.replace(",", "."));
  return parseFloat(s.replace(/,/g, ""));
}

type Variant = "trade" | "tx";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  if (TRADE_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length >= 5) return "trade";
  if (TX_HEADERS.map((h) => h.toLowerCase()).every((r) => lower.includes(r))) return "tx";
  return null;
}

export const bisqPreset: CsvPreset = {
  id: "bisq",
  name: "Bisq",
  description: "Bisq DEX trade history and transaction exports.",

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date/Time" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    return variant === "trade" ? transformTrades(headers, rows) : transformTx(headers, rows);
  },
};

function transformTrades(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "Date/Time");
  const marketIdx = colIdx(headers, "Market");
  const priceIdx = colIdx(headers, "Price");
  const btcAmtIdx = colIdx(headers, "Amount in BTC");
  const amtIdx = colIdx(headers, "Amount");
  const currIdx = colIdx(headers, "Currency");
  const offerIdx = colIdx(headers, "Offer type");
  const statusIdx = colIdx(headers, "Status");
  const feeBtcIdx = colIdx(headers, "Trade Fee BTC");

  if ([dateIdx, marketIdx, offerIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    if (statusIdx >= 0 && (row[statusIdx] ?? "").trim().toLowerCase() !== "completed") continue;

    const date = parseNamedMonthDate(row[dateIdx] ?? "");
    if (!date) continue;

    const market = (row[marketIdx] ?? "").trim();
    const parts = market.split("/");
    if (parts.length !== 2) continue;
    const [base, quote] = parts.map((s) => s.trim().toUpperCase());

    const offer = (row[offerIdx] ?? "").trim().toLowerCase();
    const isSell = offer.includes("sell");
    const side: "BUY" | "SELL" = isSell ? "SELL" : "BUY";

    const btcAmt = btcAmtIdx >= 0 ? parseEurNum(row[btcAmtIdx] ?? "0") : 0;
    const fiatAmt = amtIdx >= 0 ? parseEurNum(row[amtIdx] ?? "0") : 0;

    const baseAmt = base === "BTC" ? btcAmt : fiatAmt;
    const quoteAmt = quote === "BTC" ? btcAmt : fiatAmt;

    if (baseAmt === 0 && quoteAmt === 0) continue;

    const lines = makeTradeLines("Bisq", base, quote, side, baseAmt, quoteAmt);

    const feeBtc = feeBtcIdx >= 0 ? parseEurNum(row[feeBtcIdx] ?? "0") : 0;
    if (feeBtc > 0) lines.push(...makeFeeLines("Bisq", "BTC", feeBtc));

    records.push({ date, description: `Bisq ${side.toLowerCase()} ${base}/${quote}`, lines });
  }

  return records;
}

function transformTx(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "Date/Time");
  const amtIdx = colIdx(headers, "Amount in BTC");

  if (dateIdx === -1 || amtIdx === -1) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = parseNamedMonthDate(row[dateIdx] ?? "");
    if (!date) continue;

    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || amount === 0) continue;

    const type = amount > 0 ? "deposit" : "withdrawal";
    const lines = makeTransferLines("Bisq", "BTC", amount);

    records.push({ date, description: `Bisq ${type}: BTC`, lines });
  }

  return records;
}
