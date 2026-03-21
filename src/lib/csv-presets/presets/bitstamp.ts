import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx, parseNamedMonthDate, makeTradeLines, makeTradeDescription, makeTradeDescriptionData, makeTransferDescriptionData, makeTransferLines, makeFeeLines } from "./shared.js";
import { exchangeAssets, exchangeAssetsCurrency, EQUITY_TRADING } from "$lib/accounts/paths.js";

const EXPORT_HEADERS = ["ID", "Account", "Type", "Subtype", "Datetime", "Amount", "Amount currency"];
const ALL_HEADERS = ["Type", "Datetime", "Account", "Amount", "Value", "Rate", "Fee", "Sub Type"];
const ORDERS_HEADERS = ["Order Type", "Pair", "Price", "Amount", "Value", "Closed"];

type Variant = "export" | "all" | "orders";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n.toLowerCase());

  if ((has("Amount currency") || has("Fee currency")) && has("Subtype")) return "export";
  if (has("Order Type") && has("Pair") && has("Closed")) return "orders";
  if (has("Type") && has("Datetime") && has("Sub Type")) return "all";
  return null;
}

export const bitstampPreset: CsvPreset = {
  id: "bitstamp",
  name: "Bitstamp",
  description: "Bitstamp transaction exports, combined orders, and legacy transaction history.",
  suggestedMainAccount: exchangeAssets("Bitstamp"),

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Datetime", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    if (variant === "export") return transformExport(headers, rows);
    if (variant === "orders") return transformOrders(headers, rows);
    return transformAll(headers, rows);
  },
};

function extractDate(raw: string): string | null {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function transformExport(headers: string[], rows: string[][]): CsvRecord[] {
  const typeIdx = colIdx(headers, "Type");
  const subtypeIdx = colIdx(headers, "Subtype");
  const dateIdx = colIdx(headers, "Datetime");
  const amtIdx = colIdx(headers, "Amount");
  const amtCurrIdx = colIdx(headers, "Amount currency");
  const valIdx = colIdx(headers, "Value");
  const valCurrIdx = colIdx(headers, "Value currency");
  const feeIdx = colIdx(headers, "Fee");
  const feeCurrIdx = colIdx(headers, "Fee currency");

  if ([typeIdx, dateIdx, amtIdx, amtCurrIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const type = (row[typeIdx] ?? "").trim();
    const subtype = subtypeIdx >= 0 ? (row[subtypeIdx] ?? "").trim() : "";
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const currency = (row[amtCurrIdx] ?? "").trim().toUpperCase();
    if (isNaN(amount) || !currency) continue;

    const value = valIdx >= 0 ? parseFloat((row[valIdx] ?? "0").replace(/,/g, "")) : 0;
    const valueCurr = valCurrIdx >= 0 ? (row[valCurrIdx] ?? "").trim().toUpperCase() : "";
    const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
    const feeCurr = feeCurrIdx >= 0 ? (row[feeCurrIdx] ?? "").trim().toUpperCase() : "";

    const typeUpper = type.toUpperCase();
    const lines: CsvRecord["lines"] = [];

    if (typeUpper === "MARKET") {
      const side: "BUY" | "SELL" = subtype.toUpperCase() === "BUY" ? "BUY" : "SELL";
      if (!isNaN(value) && value > 0 && valueCurr) {
        lines.push(...makeTradeLines("Bitstamp", currency, valueCurr, side, amount, value));
      } else {
        lines.push(
          { account: exchangeAssetsCurrency("Bitstamp", currency), currency, amount: (side === "BUY" ? amount : -amount).toString() },
          { account: EQUITY_TRADING, currency, amount: (side === "BUY" ? -amount : amount).toString() },
        );
      }
      if (!isNaN(fee) && fee > 0 && feeCurr) lines.push(...makeFeeLines("Bitstamp", feeCurr, fee));

      records.push({ date, description: valueCurr ? makeTradeDescription("Bitstamp", currency, valueCurr, side) : `Bitstamp ${side.toLowerCase()} ${currency}`, descriptionData: valueCurr ? makeTradeDescriptionData("Bitstamp", currency, valueCurr, side) : { type: "cex-trade", exchange: "Bitstamp", spent: side === "SELL" ? currency : valueCurr || currency, received: side === "BUY" ? currency : valueCurr || currency }, lines });
    } else if (typeUpper === "DEPOSIT") {
      lines.push(...makeTransferLines("Bitstamp", currency, amount));
      if (!isNaN(fee) && fee > 0 && feeCurr) lines.push(...makeFeeLines("Bitstamp", feeCurr, fee));
      const depDescData = makeTransferDescriptionData("Bitstamp", currency, "deposit");
      records.push({ date, description: renderDescription(depDescData), descriptionData: depDescData, lines });
    } else if (typeUpper === "WITHDRAWAL") {
      lines.push(...makeTransferLines("Bitstamp", currency, -amount));
      if (!isNaN(fee) && fee > 0 && feeCurr) lines.push(...makeFeeLines("Bitstamp", feeCurr, fee));
      const wdDescData = makeTransferDescriptionData("Bitstamp", currency, "withdrawal");
      records.push({ date, description: renderDescription(wdDescData), descriptionData: wdDescData, lines });
    } else {
      lines.push(...makeTransferLines("Bitstamp", currency, amount));
      const opDescData = { type: "cex-operation" as const, exchange: "Bitstamp", operation: type.toLowerCase(), currency };
      records.push({ date, description: renderDescription(opDescData), descriptionData: opDescData, lines });
    }
  }

  return records;
}

function splitAmountCurrency(raw: string): { amount: number; currency: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const amount = parseFloat(parts[0].replace(/,/g, ""));
  const currency = parts[1].toUpperCase();
  if (isNaN(amount)) return null;
  return { amount, currency };
}

function transformAll(headers: string[], rows: string[][]): CsvRecord[] {
  const typeIdx = colIdx(headers, "Type");
  const dateIdx = colIdx(headers, "Datetime");
  const amtIdx = colIdx(headers, "Amount");
  const valIdx = colIdx(headers, "Value");
  const feeIdx = colIdx(headers, "Fee");
  const subIdx = colIdx(headers, "Sub Type");

  if ([typeIdx, dateIdx, amtIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = parseNamedMonthDate(row[dateIdx] ?? "");
    if (!date) continue;

    const type = (row[typeIdx] ?? "").trim().toUpperCase();
    const subtype = subIdx >= 0 ? (row[subIdx] ?? "").trim().toUpperCase() : "";
    const amtParsed = splitAmountCurrency(row[amtIdx] ?? "");
    if (!amtParsed) continue;

    const valParsed = valIdx >= 0 ? splitAmountCurrency(row[valIdx] ?? "") : null;
    const feeParsed = feeIdx >= 0 ? splitAmountCurrency(row[feeIdx] ?? "") : null;

    const lines: CsvRecord["lines"] = [];

    if (type === "MARKET") {
      const side: "BUY" | "SELL" = subtype === "BUY" ? "BUY" : "SELL";
      if (valParsed && valParsed.amount > 0) {
        lines.push(...makeTradeLines("Bitstamp", amtParsed.currency, valParsed.currency, side, amtParsed.amount, valParsed.amount));
      } else {
        lines.push(
          { account: exchangeAssetsCurrency("Bitstamp", amtParsed.currency), currency: amtParsed.currency, amount: (side === "BUY" ? amtParsed.amount : -amtParsed.amount).toString() },
          { account: EQUITY_TRADING, currency: amtParsed.currency, amount: (side === "BUY" ? -amtParsed.amount : amtParsed.amount).toString() },
        );
      }
      if (feeParsed && feeParsed.amount > 0) lines.push(...makeFeeLines("Bitstamp", feeParsed.currency, feeParsed.amount));
      records.push({ date, description: valParsed ? makeTradeDescription("Bitstamp", amtParsed.currency, valParsed.currency, side) : `Bitstamp ${side.toLowerCase()} ${amtParsed.currency}`, descriptionData: valParsed ? makeTradeDescriptionData("Bitstamp", amtParsed.currency, valParsed.currency, side) : { type: "cex-trade", exchange: "Bitstamp", spent: side === "SELL" ? amtParsed.currency : amtParsed.currency, received: side === "BUY" ? amtParsed.currency : amtParsed.currency }, lines });
    } else if (type === "DEPOSIT") {
      lines.push(...makeTransferLines("Bitstamp", amtParsed.currency, amtParsed.amount));
      const depDescData2 = makeTransferDescriptionData("Bitstamp", amtParsed.currency, "deposit");
      records.push({ date, description: renderDescription(depDescData2), descriptionData: depDescData2, lines });
    } else if (type === "WITHDRAWAL") {
      lines.push(...makeTransferLines("Bitstamp", amtParsed.currency, -amtParsed.amount));
      if (feeParsed && feeParsed.amount > 0) lines.push(...makeFeeLines("Bitstamp", feeParsed.currency, feeParsed.amount));
      const wdDescData2 = makeTransferDescriptionData("Bitstamp", amtParsed.currency, "withdrawal");
      records.push({ date, description: renderDescription(wdDescData2), descriptionData: wdDescData2, lines });
    } else {
      lines.push(...makeTransferLines("Bitstamp", amtParsed.currency, amtParsed.amount));
      const opDescData2 = { type: "cex-operation" as const, exchange: "Bitstamp", operation: type.toLowerCase(), currency: amtParsed.currency };
      records.push({ date, description: renderDescription(opDescData2), descriptionData: opDescData2, lines });
    }
  }

  return records;
}

function transformOrders(headers: string[], rows: string[][]): CsvRecord[] {
  const orderTypeIdx = colIdx(headers, "Order Type");
  const pairIdx = colIdx(headers, "Pair");
  const amtIdx = colIdx(headers, "Amount");
  const valIdx = colIdx(headers, "Value");
  const dateIdx = colIdx(headers, "Closed");

  if ([orderTypeIdx, pairIdx, amtIdx, valIdx, dateIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const parts = (row[pairIdx] ?? "").split("/");
    if (parts.length !== 2) continue;
    const [base, quote] = parts.map((s) => s.trim().toUpperCase());

    const side: "BUY" | "SELL" = (row[orderTypeIdx] ?? "").trim().toUpperCase() === "BUY" ? "BUY" : "SELL";
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
    const value = parseFloat((row[valIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(amount) || isNaN(value) || amount === 0) continue;

    const lines = makeTradeLines("Bitstamp", base, quote, side, amount, value);

    records.push({ date, description: makeTradeDescription("Bitstamp", base, quote, side), descriptionData: makeTradeDescriptionData("Bitstamp", base, quote, side), lines });
  }

  return records;
}
