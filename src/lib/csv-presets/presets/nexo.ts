import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import type { DescriptionData } from "$lib/types/description-data.js";
import { renderDescription } from "$lib/types/description-data.js";
import { colIdx, makeTransferLines, makeTransferDescriptionData } from "./shared.js";
import {
  exchangeAssets,
  exchangeAssetsCurrency,
  exchangeIncome,
  EQUITY_TRADING,
  EQUITY_EXTERNAL,
} from "$lib/accounts/paths.js";

const REQUIRED_HEADERS = [
  "Transaction", "Type", "Input Currency", "Input Amount",
  "Output Currency", "Output Amount", "Date / Time (UTC)",
];

export const nexoPreset: CsvPreset = {
  id: "nexo",
  name: "Nexo",
  description: "Nexo platform transaction history CSV.",
  suggestedMainAccount: exchangeAssets("Nexo"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = REQUIRED_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    return matched / REQUIRED_HEADERS.length >= 0.7 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date / Time (UTC)", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const typeIdx = colIdx(headers, "Type");
    const inCurrIdx = colIdx(headers, "Input Currency");
    const inAmtIdx = colIdx(headers, "Input Amount");
    const outCurrIdx = colIdx(headers, "Output Currency");
    const outAmtIdx = colIdx(headers, "Output Amount");
    const dateIdx = colIdx(headers, "Date / Time (UTC)");

    if ([typeIdx, inCurrIdx, inAmtIdx, outCurrIdx, outAmtIdx, dateIdx].some((i) => i === -1)) {
      return null;
    }

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const rawDate = row[dateIdx] ?? "";
      const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      const type = (row[typeIdx] ?? "").trim();
      const inCurr = (row[inCurrIdx] ?? "").trim().toUpperCase();
      const inAmt = parseFloat((row[inAmtIdx] ?? "0").replace(/[$,]/g, ""));
      const outCurr = (row[outCurrIdx] ?? "").trim().toUpperCase();
      const outAmt = parseFloat((row[outAmtIdx] ?? "0").replace(/[$,]/g, ""));
      const typeUpper = type.toUpperCase();

      const lines: CsvRecord["lines"] = [];

      if (typeUpper === "WITHDRAWAL") {
        // Transfer out: Input Currency/Amount is what leaves
        if (inCurr && !isNaN(inAmt)) {
          lines.push(...makeTransferLines("Nexo", inCurr, inAmt));
        }
        const wdDescData = makeTransferDescriptionData("Nexo", inCurr, "withdrawal");
        records.push({ date, description: renderDescription(wdDescData), descriptionData: wdDescData, lines });
      } else if (typeUpper === "EXCHANGE" || typeUpper === "EXCHANGEDEPOSITEDON") {
        // Trade: Input → Output
        if (inCurr && outCurr && !isNaN(inAmt) && !isNaN(outAmt)) {
          const absIn = Math.abs(inAmt);
          const absOut = Math.abs(outAmt);
          // Input is spent (negative), Output is received (positive)
          lines.push(
            { account: exchangeAssetsCurrency("Nexo", inCurr), currency: inCurr, amount: (-absIn).toString() },
            { account: EQUITY_TRADING, currency: inCurr, amount: absIn.toString() },
            { account: exchangeAssetsCurrency("Nexo", outCurr), currency: outCurr, amount: absOut.toString() },
            { account: EQUITY_TRADING, currency: outCurr, amount: (-absOut).toString() },
          );
        }
        const tradeDescData: DescriptionData = { type: "cex-trade", exchange: "Nexo", spent: inCurr, received: outCurr };
        records.push({ date, description: renderDescription(tradeDescData), descriptionData: tradeDescData, lines });
      } else if (typeUpper === "INTEREST" || typeUpper === "FIXED TERM INTEREST") {
        // Income: Output is what is earned
        const curr = outCurr || inCurr;
        const amt = !isNaN(outAmt) && outAmt > 0 ? outAmt : Math.abs(inAmt);
        if (curr && amt > 0) {
          lines.push(
            { account: exchangeAssetsCurrency("Nexo", curr), currency: curr, amount: amt.toString() },
            { account: exchangeIncome("Nexo", "Interest"), currency: curr, amount: (-amt).toString() },
          );
        }
        const intDescData: DescriptionData = { type: "cex-reward", exchange: "Nexo", kind: "interest", currency: curr };
        records.push({ date, description: renderDescription(intDescData), descriptionData: intDescData, lines });
      } else if (typeUpper === "EXCHANGE CASHBACK") {
        const curr = outCurr || inCurr;
        const amt = !isNaN(outAmt) && outAmt > 0 ? outAmt : !isNaN(inAmt) ? Math.abs(inAmt) : 0;
        if (curr && amt > 0) {
          lines.push(
            { account: exchangeAssetsCurrency("Nexo", curr), currency: curr, amount: amt.toString() },
            { account: exchangeIncome("Nexo", "Cashback"), currency: curr, amount: (-amt).toString() },
          );
        }
        const cbDescData: DescriptionData = { type: "cex-reward", exchange: "Nexo", kind: "cashback", currency: curr };
        records.push({ date, description: renderDescription(cbDescData), descriptionData: cbDescData, lines });
      } else if (typeUpper === "DEPOSIT" || typeUpper === "TOP UP" || typeUpper === "TOP UP CRYPTO") {
        const curr = outCurr || inCurr;
        const amt = !isNaN(outAmt) && outAmt > 0 ? outAmt : !isNaN(inAmt) ? Math.abs(inAmt) : 0;
        if (curr && amt > 0) {
          lines.push(...makeTransferLines("Nexo", curr, amt));
        }
        const depDescData = makeTransferDescriptionData("Nexo", curr, "deposit");
        records.push({ date, description: renderDescription(depDescData), descriptionData: depDescData, lines });
      } else {
        // Fallback: generic movement
        const curr = outCurr || inCurr;
        const amt = !isNaN(outAmt) ? outAmt : !isNaN(inAmt) ? inAmt : 0;
        if (curr && amt !== 0) {
          lines.push(
            { account: exchangeAssetsCurrency("Nexo", curr), currency: curr, amount: amt.toString() },
            { account: EQUITY_EXTERNAL, currency: curr, amount: (-amt).toString() },
          );
        }
        const opDescData: DescriptionData = { type: "cex-operation", exchange: "Nexo", operation: type.toLowerCase(), currency: curr };
        records.push({ date, description: renderDescription(opDescData), descriptionData: opDescData, lines });
      }
    }

    return records;
  },
};
