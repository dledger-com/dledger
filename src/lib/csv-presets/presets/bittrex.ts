import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, makeTradeLines, makeTransferLines, makeFeeLines, decodeUtf16Spaced } from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

const NEW_ORDER_HEADERS = ["Date", "Market", "Side", "Type", "Price", "Quantity", "Total"];
const TX_HEADERS = ["Date", "Currency", "Type", "Address", "TxId", "Amount"];
const OLD_HEADERS = ["OrderUuid", "Exchange", "Type", "Quantity", "CommissionPaid", "Price"];

type Variant = "orders-new" | "transactions" | "orders-old";

function detectVariant(headers: string[]): Variant | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (n: string) => lower.includes(n.toLowerCase());

  if (has("Market") && has("Side") && has("Quantity")) return "orders-new";
  if (has("Currency") && has("TxId") && has("Amount") && !has("Market") && !has("Rewarded From") && !has("YLD Price")) return "transactions";
  if (has("OrderUuid") || has("Exchange")) return "orders-old";

  // Try UTF-16 decoded headers
  const decoded = headers.map((h) => decodeUtf16Spaced(h).trim().toLowerCase());
  if (decoded.includes("orderuuid") || decoded.includes("exchange")) return "orders-old";

  return null;
}

export const bittrexPreset: CsvPreset = {
  id: "bittrex",
  name: "Bittrex",
  description: "Bittrex order history, transaction history, and legacy order exports.",
  suggestedMainAccount: exchangeAssets("Bittrex"),

  detect(headers: string[]): number {
    return detectVariant(headers) ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const variant = detectVariant(headers);
    if (!variant) return null;
    if (variant === "orders-new") return transformNewOrders(headers, rows);
    if (variant === "transactions") return transformTransactions(headers, rows);
    return transformOldOrders(headers, rows);
  },
};

function extractDate(raw: string): string | null {
  const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseBittrexMarket(market: string): { base: string; quote: string } | null {
  // New format: "BSV/BTC" (slash-separated, base/quote)
  if (market.includes("/")) {
    const [base, quote] = market.split("/");
    return { base: base.trim().toUpperCase(), quote: quote.trim().toUpperCase() };
  }
  // Old format: "BTC-TX" (dash-separated, quote-base)
  if (market.includes("-")) {
    const [quote, base] = market.split("-");
    return { base: base.trim().toUpperCase(), quote: quote.trim().toUpperCase() };
  }
  return null;
}

function transformNewOrders(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "Date");
  const marketIdx = colIdx(headers, "Market");
  const sideIdx = colIdx(headers, "Side");
  const qtyIdx = colIdx(headers, "Quantity");
  const totalIdx = colIdx(headers, "Total");

  if ([dateIdx, marketIdx, sideIdx, qtyIdx, totalIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const pair = parseBittrexMarket(row[marketIdx] ?? "");
    if (!pair) continue;

    const side: "BUY" | "SELL" = (row[sideIdx] ?? "").trim().toUpperCase() === "BUY" ? "BUY" : "SELL";
    const qty = parseFloat((row[qtyIdx] ?? "0").replace(/,/g, ""));
    const total = parseFloat((row[totalIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(qty) || isNaN(total) || qty === 0) continue;

    const lines = makeTradeLines("Bittrex", pair.base, pair.quote, side, qty, total);
    records.push({ date, description: `Bittrex ${side.toLowerCase()} ${pair.base}/${pair.quote}`, lines });
  }

  return records;
}

function transformTransactions(headers: string[], rows: string[][]): CsvRecord[] {
  const dateIdx = colIdx(headers, "Date");
  const currIdx = colIdx(headers, "Currency");
  const typeIdx = colIdx(headers, "Type");
  const amtIdx = colIdx(headers, "Amount");

  if ([dateIdx, currIdx, typeIdx, amtIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    const date = extractDate(row[dateIdx] ?? "");
    if (!date) continue;

    const currency = (row[currIdx] ?? "").trim().toUpperCase();
    const amount = parseFloat((row[amtIdx] ?? "0").replace(/[+,]/g, ""));
    if (!currency || isNaN(amount) || amount === 0) continue;

    const type = (row[typeIdx] ?? "").trim().toUpperCase();
    const isDeposit = type === "DEPOSIT";
    const lines = makeTransferLines("Bittrex", currency, isDeposit ? amount : -Math.abs(amount));

    records.push({ date, description: `Bittrex ${type.toLowerCase()}: ${currency}`, lines });
  }

  return records;
}

function parseOldDate(raw: string): string | null {
  // "5/8/2016   4:07:19   AM" → strip extra spaces, parse M/D/YYYY
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, month, day, year] = m;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function transformOldOrders(headers: string[], rows: string[][]): CsvRecord[] {
  // Decode UTF-16 spaced headers
  const decodedHeaders = headers.map((h) => decodeUtf16Spaced(h).trim());

  const exchIdx = colIdx(decodedHeaders, "Exchange");
  const typeIdx = colIdx(decodedHeaders, "Type");
  const qtyIdx = colIdx(decodedHeaders, "Quantity");
  const commIdx = colIdx(decodedHeaders, "CommissionPaid");
  const priceIdx = colIdx(decodedHeaders, "Price");
  const closedIdx = colIdx(decodedHeaders, "Closed");

  if ([exchIdx, typeIdx, qtyIdx, priceIdx].some((i) => i === -1)) return [];

  const records: CsvRecord[] = [];

  for (const row of rows) {
    if (row.length <= 1 && (row[0] ?? "") === "") continue;

    // Decode each cell
    const cells = row.map((c) => decodeUtf16Spaced(c).trim());

    const dateIdx = closedIdx >= 0 ? closedIdx : colIdx(decodedHeaders, "Opened");
    const date = parseOldDate(cells[dateIdx] ?? "");
    if (!date) continue;

    const pair = parseBittrexMarket(cells[exchIdx] ?? "");
    if (!pair) continue;

    const typeStr = (cells[typeIdx] ?? "").toUpperCase();
    const side: "BUY" | "SELL" = typeStr.includes("BUY") ? "BUY" : "SELL";
    const qty = parseFloat((cells[qtyIdx] ?? "0").replace(/,/g, ""));
    const total = parseFloat((cells[priceIdx] ?? "0").replace(/,/g, ""));
    if (isNaN(qty) || qty === 0) continue;

    const lines = makeTradeLines("Bittrex", pair.base, pair.quote, side, qty, isNaN(total) ? 0 : total);

    const commission = commIdx >= 0 ? parseFloat((cells[commIdx] ?? "0").replace(/,/g, "")) : 0;
    if (!isNaN(commission) && commission > 0) {
      lines.push(...makeFeeLines("Bittrex", pair.quote, commission));
    }

    records.push({ date, description: `Bittrex ${side.toLowerCase()} ${pair.base}/${pair.quote}`, lines });
  }

  return records;
}
