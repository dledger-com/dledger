import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { walletAssets, chainFees, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";
import { transferDescription, operationDescription } from "$lib/types/description-data.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx } from "./shared.js";

function hasLedgerHeaders(h: string[]): boolean {
  const lower = h.map((c) => c.trim().toLowerCase());
  return (
    lower.includes("operation date") &&
    lower.includes("currency ticker") &&
    lower.includes("operation type") &&
    lower.includes("operation hash") &&
    lower.includes("account xpub")
  );
}

/** Ledger Live uses "BTC", "ETH" etc. — map to a chain name for wallet account paths. */
function currencyToChain(ticker: string): string {
  const map: Record<string, string> = {
    BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", DOT: "Polkadot",
    ATOM: "Cosmos", BNB: "BSC", ADA: "Cardano", XRP: "XRP",
    AVAX: "Avalanche", MATIC: "Polygon", NEAR: "NEAR", ALGO: "Algorand",
  };
  return map[ticker] ?? ticker;
}

export const ledgerLivePreset: CsvPreset = {
  id: "ledger-live",
  name: "Ledger Live",
  description: "Ledger Live operations export (multi-chain wallet).",

  detect(headers: string[], _sampleRows: string[][]): number {
    return hasLedgerHeaders(headers) ? 90 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Operation Date" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    if (!hasLedgerHeaders(headers)) return null;

    const dateIdx = colIdx(headers, "Operation Date");
    const statusIdx = colIdx(headers, "Status");
    const tickerIdx = colIdx(headers, "Currency Ticker");
    const typeIdx = colIdx(headers, "Operation Type");
    const amountIdx = colIdx(headers, "Operation Amount");
    const feesIdx = colIdx(headers, "Operation Fees");
    const hashIdx = colIdx(headers, "Operation Hash");
    const accountIdx = colIdx(headers, "Account Name");

    if ([dateIdx, tickerIdx, typeIdx, amountIdx, hashIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const status = (row[statusIdx] ?? "").trim();
      if (status === "Pending" || status === "Aborted") continue;

      const opType = (row[typeIdx] ?? "").trim().toUpperCase();
      // Skip token opt-in/opt-out (zero-value Solana account operations)
      if (opType === "OPT_IN" || opType === "OPT_OUT") continue;

      const rawDate = (row[dateIdx] ?? "").trim();
      const date = rawDate.slice(0, 10); // ISO 8601 "2025-06-23T09:12:18.000Z" → "2025-06-23"
      if (!date || date.length !== 10) continue;

      const ticker = (row[tickerIdx] ?? "").trim().toUpperCase();
      if (!ticker) continue;

      const amount = Math.abs(parseFloat(row[amountIdx] ?? "0"));
      const fees = Math.abs(parseFloat(row[feesIdx] ?? "0"));
      const hash = (row[hashIdx] ?? "").trim();
      const accountName = (row[accountIdx] ?? "Ledger").trim();

      if (isNaN(amount) || amount === 0 && opType !== "FEES") continue;

      const chain = currencyToChain(ticker);
      const walletAccount = walletAssets(chain, accountName);

      const lines: CsvRecord["lines"] = [];
      let desc = "";

      if (opType === "IN") {
        // Receive: credit wallet, debit equity
        const netAmount = amount;
        lines.push(
          { account: walletAccount, currency: ticker, amount: netAmount.toString() },
          { account: EQUITY_EXTERNAL, currency: ticker, amount: (-netAmount).toString() },
        );
        const descData = transferDescription("Ledger", "deposit", ticker);
        desc = renderDescription(descData);
      } else if (opType === "OUT") {
        // Send: the amount already includes fees for UTXO chains
        // Net send = amount - fees (deducted from wallet), fees go to expense
        const netSend = amount - fees;
        lines.push(
          { account: walletAccount, currency: ticker, amount: (-netSend).toString() },
          { account: EQUITY_EXTERNAL, currency: ticker, amount: netSend.toString() },
        );
        if (fees > 0) {
          lines.push(
            { account: chainFees(chain), currency: ticker, amount: fees.toString() },
            { account: walletAccount, currency: ticker, amount: (-fees).toString() },
          );
        }
        const descData = transferDescription("Ledger", "withdrawal", ticker);
        desc = renderDescription(descData);
      } else if (opType === "FEES") {
        // Fee-only transaction (e.g., ETH gas for token approval)
        if (fees <= 0) continue;
        lines.push(
          { account: chainFees(chain), currency: ticker, amount: fees.toString() },
          { account: walletAccount, currency: ticker, amount: (-fees).toString() },
        );
        const descData = operationDescription("Ledger", "fee", ticker);
        desc = renderDescription(descData);
      } else {
        continue;
      }

      records.push({ date, description: desc, lines, sourceKey: hash || undefined });
    }

    return records;
  },
};
