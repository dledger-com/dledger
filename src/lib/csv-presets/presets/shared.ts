import type { CsvRecord } from "../types.js";
import type { DescriptionData } from "$lib/types/description-data.js";
import {
  exchangeAssetsCurrency,
  exchangeFees,
  EQUITY_TRADING,
  EQUITY_EXTERNAL,
} from "$lib/accounts/paths.js";

const DEFAULT_QUOTES = [
  "USDT", "USDC", "BUSD", "TUSD", "FDUSD",
  "BTC", "ETH", "BNB", "EUR", "GBP", "USD", "TRY", "AUD", "BRL",
];

/** Parse trading pair strings: "BTC/USDT", "BTC_USDT", "BTCUSDT" */
export function parsePair(
  pair: string,
  quotes: string[] = DEFAULT_QUOTES,
): { base: string; quote: string } | null {
  const upper = pair.trim().toUpperCase();

  if (upper.includes("/")) {
    const [base, quote] = upper.split("/");
    return { base: base.trim(), quote: quote.trim() };
  }

  if (upper.includes("_")) {
    const [base, quote] = upper.split("_");
    return { base: base.trim(), quote: quote.trim() };
  }

  for (const q of quotes) {
    if (upper.endsWith(q) && upper.length > q.length) {
      return { base: upper.slice(0, -q.length), quote: q };
    }
  }

  return null;
}

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse dates like "May 5, 2020 4:47:08 PM", "Aug. 02, 2016, 07:27 PM", "May 31 2024, 4:58 AM EDT" */
export function parseNamedMonthDate(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+(UTC|EDT|EST|CDT|CST|PDT|PST|GMT)$/i, "");
  const normalized = cleaned.replace(/\./g, "").replace(/\s+/g, " ").trim();

  const match = normalized.match(
    /^(\w{3,9})\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (!match) return null;

  const [, monthStr, day, year, , , , ] = match;
  const monthKey = monthStr.slice(0, 3).toLowerCase();
  const month = MONTH_MAP[monthKey];
  if (!month) return null;

  return `${year}-${month}-${day.padStart(2, "0")}`;
}

/** Build standard buy/sell + Equity:Trading lines */
export function makeTradeLines(
  exchange: string,
  base: string,
  quote: string,
  side: "BUY" | "SELL",
  baseAmt: number,
  quoteAmt: number,
): CsvRecord["lines"] {
  const lines: CsvRecord["lines"] = [];

  if (side === "BUY") {
    // BUY: spend quote, receive base → quote line first
    lines.push(
      { account: exchangeAssetsCurrency(exchange, quote), currency: quote, amount: (-quoteAmt).toString() },
      { account: exchangeAssetsCurrency(exchange, base), currency: base, amount: baseAmt.toString() },
    );
  } else {
    lines.push(
      { account: exchangeAssetsCurrency(exchange, base), currency: base, amount: (-baseAmt).toString() },
      { account: exchangeAssetsCurrency(exchange, quote), currency: quote, amount: quoteAmt.toString() },
    );
  }

  for (const l of [...lines]) {
    lines.push({
      account: EQUITY_TRADING,
      currency: l.currency,
      amount: (-parseFloat(l.amount)).toString(),
    });
  }

  return lines;
}

/** Build deposit/withdrawal + Equity:External lines */
export function makeTransferLines(
  exchange: string,
  currency: string,
  amount: number,
): CsvRecord["lines"] {
  return [
    { account: exchangeAssetsCurrency(exchange, currency), currency, amount: amount.toString() },
    { account: EQUITY_EXTERNAL, currency, amount: (-amount).toString() },
  ];
}

/** Build Expenses + Assets deduction lines for fees */
export function makeFeeLines(
  exchange: string,
  currency: string,
  amount: number,
): CsvRecord["lines"] {
  if (amount <= 0) return [];
  return [
    { account: exchangeFees(exchange), currency, amount: amount.toString() },
    { account: exchangeAssetsCurrency(exchange, currency), currency, amount: (-amount).toString() },
  ];
}

/** Build consistent trade description: "Exchange trade: spent → received" */
export function makeTradeDescription(
  exchange: string, base: string, quote: string, side: "BUY" | "SELL",
): string {
  return side === "BUY"
    ? `${exchange} trade: ${quote} → ${base}`
    : `${exchange} trade: ${base} → ${quote}`;
}

/** Case-insensitive column index lookup */
export function colIdx(headers: string[], name: string): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const idx = lower.indexOf(name.toLowerCase());
  return idx >= 0 ? idx : -1;
}

/** Build structured description data for CEX trades */
export function makeTradeDescriptionData(
  exchange: string, base: string, quote: string, side: "BUY" | "SELL",
): DescriptionData {
  return side === "BUY"
    ? { type: "cex-trade", exchange, spent: quote, received: base }
    : { type: "cex-trade", exchange, spent: base, received: quote };
}

/** Build structured description data for CEX deposits/withdrawals */
export function makeTransferDescriptionData(
  exchange: string, currency: string, direction: "deposit" | "withdrawal",
): DescriptionData {
  return { type: "cex-transfer", exchange, direction, currency };
}

/** Build structured description data for CEX fee operations */
export function makeFeeDescriptionData(
  exchange: string, currency: string,
): DescriptionData {
  return { type: "cex-operation", exchange, operation: "fee", currency };
}

/** Detect and strip null-byte spacing from UTF-16 encoded CSVs */
export function decodeUtf16Spaced(raw: string): string {
  if (raw.length < 4) return raw;

  let spaceCount = 0;
  const checkLen = Math.min(raw.length, 40);
  for (let i = 1; i < checkLen; i += 2) {
    if (raw[i] === " " || raw.charCodeAt(i) === 0) spaceCount++;
  }

  if (spaceCount / Math.floor(checkLen / 2) < 0.8) return raw;

  let result = "";
  for (let i = 0; i < raw.length; i += 2) {
    result += raw[i];
  }
  return result;
}
