import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";

const REQUIRED_HEADERS = [
  "Timestamp", "Transaction Type", "Asset", "Quantity Transacted",
  "Subtotal", "Total (inclusive of fees and/or spread)",
  "Fees and/or Spread",
];

// Alternate header names Coinbase uses
const ALT_HEADERS = [
  "Timestamp", "Transaction Type", "Asset", "Quantity Transacted",
  "Subtotal", "Total", "Fees",
];

function matchHeaders(headers: string[], required: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  return required.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length / required.length;
}

export const coinbaseTransactionsPreset: CsvPreset = {
  id: "coinbase-transactions",
  name: "Coinbase Transactions",
  description: "Coinbase transaction history CSV with Timestamp, Transaction Type, Asset, Quantity, Subtotal, Total, Fees.",
  suggestedMainAccount: "Assets:Exchanges:Coinbase",

  detect(headers: string[]): number {
    const bestMatch = Math.max(
      matchHeaders(headers, REQUIRED_HEADERS),
      matchHeaders(headers, ALT_HEADERS),
    );
    return bestMatch >= 0.7 ? 85 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    return {
      dateColumn: "Timestamp",
      descriptionColumn: "Transaction Type",
      dateFormat: "ISO8601",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    const timestampIdx = col("Timestamp");
    const typeIdx = col("Transaction Type");
    const assetIdx = col("Asset");
    const qtyIdx = col("Quantity Transacted");
    const subtotalIdx = col("Subtotal");
    const totalIdx = col("Total (inclusive of fees and/or spread)") >= 0
      ? col("Total (inclusive of fees and/or spread)")
      : col("Total");
    const feesIdx = col("Fees and/or Spread") >= 0
      ? col("Fees and/or Spread")
      : col("Fees");
    const spotPriceIdx = col("Spot Price at Transaction");
    const spotCurrIdx = col("Spot Price Currency");

    if ([timestampIdx, typeIdx, assetIdx, qtyIdx].some((i) => i === -1)) {
      return null;
    }

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[timestampIdx] ?? "";
      const dateMatch = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      const txType = (row[typeIdx] ?? "").trim();
      const asset = (row[assetIdx] ?? "").trim().toUpperCase();
      const qty = parseFloat((row[qtyIdx] ?? "0").replace(/,/g, ""));
      const quoteCurrency = spotCurrIdx >= 0 ? (row[spotCurrIdx] ?? "USD").trim().toUpperCase() : "USD";
      const total = totalIdx >= 0 ? parseFloat((row[totalIdx] ?? "0").replace(/[$,]/g, "")) : 0;
      const fees = feesIdx >= 0 ? parseFloat((row[feesIdx] ?? "0").replace(/[$,]/g, "")) : 0;

      if (isNaN(qty) || qty === 0) continue;

      const lines: CsvRecord["lines"] = [];
      const typeUpper = txType.toUpperCase();

      if (typeUpper === "BUY") {
        // Buy: receive crypto, spend fiat
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: qty.toString() },
          { account: `Equity:Trading`, currency: asset, amount: (-qty).toString() },
        );
        if (!isNaN(total) && total > 0) {
          lines.push(
            { account: `Assets:Exchanges:Coinbase:${quoteCurrency}`, currency: quoteCurrency, amount: (-total).toString() },
            { account: `Equity:Trading`, currency: quoteCurrency, amount: total.toString() },
          );
        }
      } else if (typeUpper === "SELL") {
        // Sell: spend crypto, receive fiat
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: (-qty).toString() },
          { account: `Equity:Trading`, currency: asset, amount: qty.toString() },
        );
        if (!isNaN(total) && total > 0) {
          lines.push(
            { account: `Assets:Exchanges:Coinbase:${quoteCurrency}`, currency: quoteCurrency, amount: total.toString() },
            { account: `Equity:Trading`, currency: quoteCurrency, amount: (-total).toString() },
          );
        }
      } else if (typeUpper === "SEND") {
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: (-qty).toString() },
          { account: "Equity:External", currency: asset, amount: qty.toString() },
        );
      } else if (typeUpper === "RECEIVE") {
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: qty.toString() },
          { account: "Equity:External", currency: asset, amount: (-qty).toString() },
        );
      } else if (["REWARDS INCOME", "STAKING INCOME", "LEARNING REWARD", "COINBASE EARN"].includes(typeUpper)) {
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: qty.toString() },
          { account: "Income:Exchanges:Coinbase:Rewards", currency: asset, amount: (-qty).toString() },
        );
      } else if (typeUpper === "CONVERT") {
        // Conversion: usually qty is what you receive; we'll treat as trade
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: qty.toString() },
          { account: "Equity:Trading", currency: asset, amount: (-qty).toString() },
        );
      } else {
        // Generic: just record the movement
        lines.push(
          { account: `Assets:Exchanges:Coinbase:${asset}`, currency: asset, amount: qty.toString() },
          { account: "Equity:External", currency: asset, amount: (-qty).toString() },
        );
      }

      // Fees
      if (!isNaN(fees) && fees > 0) {
        lines.push(
          { account: "Expenses:Exchanges:Coinbase:Fees", currency: quoteCurrency, amount: fees.toString() },
          { account: `Assets:Exchanges:Coinbase:${quoteCurrency}`, currency: quoteCurrency, amount: (-fees).toString() },
        );
      }

      records.push({
        date,
        description: `Coinbase ${txType.toLowerCase()}: ${asset}`,
        lines,
      });
    }

    return records;
  },
};
