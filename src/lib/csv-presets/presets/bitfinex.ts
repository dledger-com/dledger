import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, parsePair, makeTradeLines, makeTradeDescription, makeTransferLines, makeFeeLines } from "./shared.js";
import {
  exchangeAssets,
  exchangeAssetsCurrency,
  exchangeFees,
  EQUITY_EXTERNAL,
  EQUITY_TRADING,
} from "$lib/accounts/paths.js";

type Variant = "trades" | "trades-old" | "ledgers" | "movements";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n.toLowerCase());

  // Trades new: has PAIR + FEE CURRENCY
  if (has("pair") && has("fee currency")) return "trades";
  // Trades old: has Pair but not FEE CURRENCY (fewer columns)
  if (has("pair") && !has("fee currency") && !has("wallet")) return "trades-old";
  // Ledgers: has DESCRIPTION + WALLET
  if (has("description") && has("wallet")) return "ledgers";
  // Movements: has STATUS + FEES + TRANSACTION ID (but not WALLET)
  if (has("status") && has("fees") && !has("wallet")) return "movements";
  return null;
}

export const bitfinexPreset: CsvPreset = {
  id: "bitfinex",
  name: "Bitfinex",
  description: "Bitfinex trades, ledgers, and movements CSV exports.",
  suggestedMainAccount: exchangeAssets("Bitfinex"),

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "DATE", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    if (variant === "trades") return transformTrades(headers, rows);
    if (variant === "trades-old") return transformTradesOld(headers, rows);
    if (variant === "ledgers") return transformLedgers(headers, rows);
    return transformMovements(headers, rows);
  },
};

function extractDate(raw: string): string | null {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function transformTrades(headers: string[], rows: string[][]): CsvRecord[] {
  const pairIdx = colIdx(headers, "PAIR");
  const amtIdx = colIdx(headers, "AMOUNT");
  const priceIdx = colIdx(headers, "PRICE");
  const feeIdx = colIdx(headers, "FEE");
  const feeCurrIdx = colIdx(headers, "FEE CURRENCY");
  const dateIdx = colIdx(headers, "DATE");

  if ([pairIdx, amtIdx, priceIdx, dateIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const pair = parsePair(row[pairIdx] ?? "");
    if (!pair) continue;

    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const price = parseFloat((row[priceIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || amount === 0 || isNaN(price)) continue;

    const side: "BUY" | "SELL" = amount > 0 ? "BUY" : "SELL";
    const baseAmt = Math.abs(amount);
    const quoteAmt = baseAmt * price;

    const lines = makeTradeLines("Bitfinex", pair.base, pair.quote, side, baseAmt, quoteAmt);

    const fee = feeIdx >= 0 ? Math.abs(parseFloat((row[feeIdx] ?? "0").replace(/,/g, ""))) : 0;
    const feeCurr = feeCurrIdx >= 0 ? (row[feeCurrIdx] ?? "").trim().toUpperCase() : pair.quote;
    if (fee > 0) lines.push(...makeFeeLines("Bitfinex", feeCurr, fee));

    records.push({
      date,
      description: makeTradeDescription("Bitfinex", pair.base, pair.quote, side),
      lines,
    });
  }

  return records;
}

function transformTradesOld(headers: string[], rows: string[][]): CsvRecord[] {
  const pairIdx = colIdx(headers, "Pair");
  const amtIdx = colIdx(headers, "Amount");
  const priceIdx = colIdx(headers, "Price");
  const dateIdx = colIdx(headers, "Date");

  if ([pairIdx, amtIdx, priceIdx, dateIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const pair = parsePair(row[pairIdx] ?? "");
    if (!pair) continue;

    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const price = parseFloat((row[priceIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || amount === 0 || isNaN(price)) continue;

    const side: "BUY" | "SELL" = amount > 0 ? "BUY" : "SELL";
    const baseAmt = Math.abs(amount);
    const quoteAmt = baseAmt * price;

    const lines = makeTradeLines("Bitfinex", pair.base, pair.quote, side, baseAmt, quoteAmt);

    records.push({
      date,
      description: makeTradeDescription("Bitfinex", pair.base, pair.quote, side),
      lines,
    });
  }

  return records;
}

function transformLedgers(headers: string[], rows: string[][]): CsvRecord[] {
  const descIdx = colIdx(headers, "DESCRIPTION");
  const currIdx = colIdx(headers, "CURRENCY");
  const amtIdx = colIdx(headers, "AMOUNT");
  const dateIdx = colIdx(headers, "DATE");

  if ([descIdx, currIdx, amtIdx, dateIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const desc = (row[descIdx] ?? "").toLowerCase();

    let counterAccount = EQUITY_EXTERNAL;
    if (desc.includes("exchange") || desc.includes("trading")) {
      counterAccount = EQUITY_TRADING;
    }

    const isFee = desc.includes("fee") && amount < 0;
    const lines: CsvRecord["lines"] = isFee
      ? [
          { account: exchangeFees("Bitfinex"), currency, amount: Math.abs(amount).toString() },
          { account: exchangeAssetsCurrency("Bitfinex", currency), currency, amount: amount.toString() },
        ]
      : [
          { account: exchangeAssetsCurrency("Bitfinex", currency), currency, amount: amount.toString() },
          { account: counterAccount, currency, amount: (-amount).toString() },
        ];

    records.push({
      date,
      description: `Bitfinex: ${(row[descIdx] ?? "").trim().slice(0, 80)}`,
      lines,
    });
  }

  return records;
}

function transformMovements(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "DATE");
  const currIdx = colIdx(headers, "CURRENCY");
  const statusIdx = colIdx(headers, "STATUS");
  const amtIdx = colIdx(headers, "AMOUNT");
  const feesIdx = colIdx(headers, "FEES");

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

    const type = amount > 0 ? "deposit" : "withdrawal";
    const lines: CsvRecord["lines"] = makeTransferLines("Bitfinex", currency, amount);

    const fees = feesIdx >= 0 ? Math.abs(parseFloat((row[feesIdx] ?? "0").replace(/,/g, ""))) : 0;
    if (fees > 0) lines.push(...makeFeeLines("Bitfinex", currency, fees));

    records.push({ date, description: `Bitfinex ${type}: ${currency}`, lines });
  }

  return records;
}
