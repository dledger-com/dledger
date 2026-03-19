import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import type { DescriptionData } from "$lib/types/description-data.js";
import { colIdx, makeTransferLines, makeTransferDescriptionData, makeFeeLines } from "./shared.js";
import {
  exchangeAssets,
  exchangeAssetsCurrency,
  exchangeRewards,
  exchangeExpense,
  EQUITY_TRADING,
  EQUITY_EXTERNAL,
} from "$lib/accounts/paths.js";

const REQUIRED_HEADERS = [
  "Timestamp (UTC)", "Transaction Description", "Currency", "Amount",
  "Native Currency", "Native Amount", "Transaction Kind",
];

export const cryptoComAppPreset: CsvPreset = {
  id: "crypto-com-app",
  name: "Crypto.com App",
  description: "Crypto.com App transaction export (crypto, card, and fiat).",
  suggestedMainAccount: exchangeAssets("CryptoCom"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = REQUIRED_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    return matched / REQUIRED_HEADERS.length >= 0.7 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Timestamp (UTC)", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const tsIdx = colIdx(headers, "Timestamp (UTC)");
    const descIdx = colIdx(headers, "Transaction Description");
    const currIdx = colIdx(headers, "Currency");
    const amtIdx = colIdx(headers, "Amount");
    const toCurrIdx = colIdx(headers, "To Currency");
    const toAmtIdx = colIdx(headers, "To Amount");
    const kindIdx = colIdx(headers, "Transaction Kind");

    if ([tsIdx, currIdx, amtIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const rawDate = row[tsIdx] ?? "";
      const dateMatch = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      const desc = (row[descIdx] ?? "").trim();
      const currency = (row[currIdx] ?? "").trim().toUpperCase();
      const amount = parseFloat((row[amtIdx] ?? "0").replace(/,/g, ""));
      if (!currency || isNaN(amount)) continue;

      const toCurr = toCurrIdx >= 0 ? (row[toCurrIdx] ?? "").trim().toUpperCase() : "";
      const toAmt = toAmtIdx >= 0 ? parseFloat((row[toAmtIdx] ?? "0").replace(/,/g, "")) : NaN;
      const kind = kindIdx >= 0 ? (row[kindIdx] ?? "").trim().toLowerCase() : "";

      const lines: CsvRecord["lines"] = [];

      if (kind === "viban_purchase" || kind === "dust_conversion_credited" ||
          kind === "dust_conversion_debited" || kind === "crypto_viban") {
        // Trade: from Currency/Amount to To Currency/To Amount
        if (toCurr && !isNaN(toAmt)) {
          lines.push(
            { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
            { account: EQUITY_TRADING, currency, amount: (-amount).toString() },
            { account: exchangeAssetsCurrency("CryptoCom", toCurr), currency: toCurr, amount: toAmt.toString() },
            { account: EQUITY_TRADING, currency: toCurr, amount: (-toAmt).toString() },
          );
        } else {
          lines.push(
            { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
            { account: EQUITY_TRADING, currency, amount: (-amount).toString() },
          );
        }
        const tradeDescData: DescriptionData = toCurr
          ? { type: "cex-trade", exchange: "Crypto.com", spent: amount < 0 ? currency : toCurr, received: amount < 0 ? toCurr : currency }
          : { type: "cex-operation", exchange: "Crypto.com", operation: kind, currency };
        records.push({ date, description: `Crypto.com ${desc.slice(0, 60)}`, descriptionData: tradeDescData, lines });
      } else if (kind === "referral_card_cashback" || kind === "supercharger_reward_to_app_credited" ||
                 kind === "crypto_earn_interest_paid" || kind === "mco_stake_reward") {
        // Income
        lines.push(
          { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
          { account: exchangeRewards("CryptoCom"), currency, amount: (-amount).toString() },
        );
        records.push({ date, description: `Crypto.com ${desc.slice(0, 60)}`, descriptionData: { type: "cex-reward", exchange: "Crypto.com", kind: kind.replace(/_/g, " "), currency }, lines });
      } else if (kind === "card_cashback_reverted") {
        // Reversal of cashback
        lines.push(
          { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
          { account: exchangeRewards("CryptoCom"), currency, amount: (-amount).toString() },
        );
        records.push({ date, description: `Crypto.com cashback reverted: ${currency}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com", operation: "cashback reverted", currency }, lines });
      } else if (kind === "crypto_withdrawal" || kind === "viban_withdrawal") {
        lines.push(...makeTransferLines("CryptoCom", currency, amount));
        records.push({ date, description: `Crypto.com withdrawal: ${currency}`, descriptionData: makeTransferDescriptionData("Crypto.com", currency, "withdrawal"), lines });
      } else if (kind === "crypto_deposit" || kind === "viban_deposit") {
        lines.push(...makeTransferLines("CryptoCom", currency, amount));
        records.push({ date, description: `Crypto.com deposit: ${currency}`, descriptionData: makeTransferDescriptionData("Crypto.com", currency, "deposit"), lines });
      } else if (kind === "viban_card_top_up") {
        // Card top-up: transfer from fiat wallet to card
        lines.push(...makeTransferLines("CryptoCom", currency, amount));
        records.push({ date, description: `Crypto.com card top-up: ${currency}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com", operation: "card top-up", currency }, lines });
      } else if (kind === "" && amount < 0) {
        // Card spending (no Transaction Kind)
        lines.push(
          { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
          { account: exchangeExpense("CryptoCom", "Card"), currency, amount: (-amount).toString() },
        );
        records.push({ date, description: `Crypto.com card: ${desc.slice(0, 60)}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com", operation: "card", currency }, lines });
      } else if (kind === "" && amount > 0) {
        // Card refund or deposit without kind
        lines.push(...makeTransferLines("CryptoCom", currency, amount));
        records.push({ date, description: `Crypto.com: ${desc.slice(0, 60)}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com", operation: "deposit", currency }, lines });
      } else {
        // Fallback: generic movement
        lines.push(
          { account: exchangeAssetsCurrency("CryptoCom", currency), currency, amount: amount.toString() },
          { account: EQUITY_EXTERNAL, currency, amount: (-amount).toString() },
        );
        records.push({ date, description: `Crypto.com ${kind || desc.slice(0, 40)}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com", operation: kind || "unknown", currency }, lines });
      }
    }

    return records;
  },
};
