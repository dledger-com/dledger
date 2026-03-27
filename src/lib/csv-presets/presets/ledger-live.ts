import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { walletAssets, chainFees, defiAssets, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";
import { onchainTransferDescription, operationDescription, defiActionDescription } from "$lib/types/description-data.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx } from "./shared.js";
import { isAToken, extractATokenUnderlying, aaveActionDescription } from "$lib/handlers/aave.js";

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

/** Map native currency tickers to chain names */
const TICKER_TO_CHAIN: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", DOT: "Polkadot",
  ATOM: "Cosmos", BNB: "BSC", ADA: "Cardano", XRP: "XRP",
  AVAX: "Avalanche", MATIC: "Polygon", POL: "Polygon", NEAR: "NEAR", ALGO: "Algorand",
  LTC: "Litecoin", DOGE: "Dogecoin", XLM: "Stellar", XTZ: "Tezos",
  TON: "TON", FLR: "Flare", CRO: "Cronos", FTM: "Fantom",
};

/**
 * Detect chain from ticker + account address (xpub column).
 * For native currencies, use the ticker→chain map.
 * For tokens (ERC-20 etc.), detect from the account address format.
 */
function detectChain(ticker: string, accountXpub: string): string {
  // Known native currencies
  const known = TICKER_TO_CHAIN[ticker];
  if (known) return known;

  // Detect chain from account address format
  if (accountXpub.startsWith("0x")) return "Ethereum";
  if (/^(xpub|ypub|zpub)/.test(accountXpub)) return "Bitcoin";

  // Fallback: use ticker as chain name (shouldn't happen often)
  return ticker;
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
    const xpubIdx = colIdx(headers, "Account xpub");

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

      const rawTicker = (row[tickerIdx] ?? "").trim();
      if (!rawTicker) continue;

      // Detect Aave aTokens (aEthWBTC, aEthwstETH, etc.) and extract underlying
      const aTokenUnderlying = isAToken(rawTicker) ? extractATokenUnderlying(rawTicker) : null;
      const ticker = aTokenUnderlying ? aTokenUnderlying.toUpperCase() : rawTicker.toUpperCase();

      const rawAmount = parseFloat(row[amountIdx] ?? "0");
      const amount = isNaN(rawAmount) ? 0 : Math.abs(rawAmount);
      const rawFees = parseFloat(row[feesIdx] ?? "0");
      const fees = isNaN(rawFees) ? 0 : Math.abs(rawFees);
      const hash = (row[hashIdx] ?? "").trim();
      const accountName = (row[accountIdx] ?? "Ledger").trim();
      const accountXpub = xpubIdx >= 0 ? (row[xpubIdx] ?? "").trim() : "";

      // Skip rows with no financial impact
      if (amount === 0 && fees === 0) continue;

      // Treat zero-amount rows with fees as fee-only operations
      if (amount === 0 && fees > 0 && opType !== "FEES") {
        const chain = detectChain(ticker, accountXpub);
        const walletAccount = walletAssets(chain, accountName);
        const descData = operationDescription(chain, "fee", ticker);
        records.push({
          date, description: renderDescription(descData), descriptionData: descData,
          lines: [
            { account: chainFees(chain), currency: ticker, amount: fees.toString() },
            { account: walletAccount, currency: ticker, amount: (-fees).toString() },
          ],
          groupKey: hash || undefined,
          sourceKey: hash || undefined,
        });
        continue;
      }

      const chain = detectChain(ticker, accountXpub);
      const walletAccount = walletAssets(chain, accountName);
      const aaveSupply = aTokenUnderlying ? defiAssets("Aave", "Supply") : null;

      const lines: CsvRecord["lines"] = [];
      let descData: import("$lib/types/description-data.js").DescriptionData | undefined;

      if (opType === "IN" && aaveSupply) {
        // Aave aToken received → supply position (underlying deposited to Aave)
        lines.push(
          { account: aaveSupply, currency: ticker, amount: amount.toString() },
          { account: walletAccount, currency: ticker, amount: (-amount).toString() },
        );
        descData = defiActionDescription("Aave", "supply", chain, hash, aaveActionDescription("Supply", amount, ticker, hash));
      } else if (opType === "OUT" && aaveSupply) {
        // Aave aToken sent → withdraw position (underlying withdrawn from Aave)
        const netSend = amount - fees;
        if (netSend > 0) {
          lines.push(
            { account: walletAccount, currency: ticker, amount: netSend.toString() },
            { account: aaveSupply, currency: ticker, amount: (-netSend).toString() },
          );
        }
        if (fees > 0) {
          lines.push(
            { account: chainFees(chain), currency: ticker, amount: fees.toString() },
            { account: walletAccount, currency: ticker, amount: (-fees).toString() },
          );
        }
        if (lines.length === 0) continue;
        descData = defiActionDescription("Aave", "withdraw", chain, hash, aaveActionDescription("Withdraw", netSend > 0 ? netSend : amount, ticker, hash));

      } else if (opType === "IN") {
        // Receive: credit wallet, debit equity
        const netAmount = amount;
        lines.push(
          { account: walletAccount, currency: ticker, amount: netAmount.toString() },
          { account: EQUITY_EXTERNAL, currency: ticker, amount: (-netAmount).toString() },
        );
        descData = onchainTransferDescription(chain, ticker, "received", { txHash: hash });
      } else if (opType === "OUT") {
        // Send: the amount already includes fees for UTXO chains
        // Net send = amount - fees (deducted from wallet), fees go to expense
        const netSend = amount - fees;
        if (netSend > 0) {
          lines.push(
            { account: walletAccount, currency: ticker, amount: (-netSend).toString() },
            { account: EQUITY_EXTERNAL, currency: ticker, amount: netSend.toString() },
          );
        }
        if (fees > 0) {
          lines.push(
            { account: chainFees(chain), currency: ticker, amount: fees.toString() },
            { account: walletAccount, currency: ticker, amount: (-fees).toString() },
          );
        }
        if (lines.length === 0) continue;
        descData = onchainTransferDescription(chain, ticker, "sent", { txHash: hash });
      } else if (opType === "FEES") {
        // Fee-only transaction (e.g., ETH gas for token approval)
        if (fees <= 0) continue;
        lines.push(
          { account: chainFees(chain), currency: ticker, amount: fees.toString() },
          { account: walletAccount, currency: ticker, amount: (-fees).toString() },
        );
        descData = operationDescription(chain, "fee", ticker);
      } else {
        continue;
      }

      records.push({ date, description: renderDescription(descData!), descriptionData: descData, lines, groupKey: hash || undefined, sourceKey: hash || undefined });
    }

    return records;
  },
};
