import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, makeTransferLines, makeTransferDescriptionData, makeFeeLines } from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

// French/Italian mixed headers from Crypto.com Exchange exports
const FRENCH_HEADERS = ["Date", "Monnaie", "Type", "Frais", "TXID", "Statut"];
const ALT_HEADER_MAP: Record<string, string[]> = {
  "monnaie": ["monnaie", "currency"],
  "type": ["type"],
  "quantité": ["quantité", "quantita", "quantità", "quantity"],
  "frais": ["frais", "fees", "fee"],
  "informations": ["informations", "informazioni", "information"],
  "statut": ["statut", "status"],
};

function findCol(headers: string[], alts: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const alt of alts) {
    const idx = lower.indexOf(alt);
    if (idx >= 0) return idx;
  }
  return -1;
}

export const cryptoComExchangePreset: CsvPreset = {
  id: "crypto-com-exchange",
  name: "Crypto.com Exchange",
  description: "Crypto.com Exchange deposit and withdrawal CSV (French/Italian headers).",
  suggestedMainAccount: exchangeAssets("CryptoComExchange"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const matched = FRENCH_HEADERS.map((h) => h.toLowerCase()).filter((r) => lower.includes(r)).length;
    // Also check for variant header names
    const hasMonnaie = findCol(headers, ALT_HEADER_MAP["monnaie"]) >= 0;
    const hasStatut = findCol(headers, ALT_HEADER_MAP["statut"]) >= 0;
    if (hasMonnaie && hasStatut) return 85;
    return matched >= 4 ? 85 : 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date", dateFormat: "ISO8601" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const dateIdx = colIdx(headers, "Date");
    const currIdx = findCol(headers, ALT_HEADER_MAP["monnaie"]);
    const typeIdx = findCol(headers, ALT_HEADER_MAP["type"]);
    const qtyIdx = findCol(headers, ALT_HEADER_MAP["quantité"]);
    const feeIdx = findCol(headers, ALT_HEADER_MAP["frais"]);
    const statusIdx = findCol(headers, ALT_HEADER_MAP["statut"]);

    if ([dateIdx, currIdx, typeIdx, qtyIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      // Filter by status: "Terminé" (completed) or "COMPLETED"
      if (statusIdx >= 0) {
        const status = (row[statusIdx] ?? "").trim().toLowerCase();
        if (status !== "terminé" && status !== "completed" && status !== "termine") continue;
      }

      // Date: "2020-04-30 09:02:15(2020-04-30 07:02:15 UTC)" → extract before "("
      const rawDate = (row[dateIdx] ?? "").split("(")[0].trim();
      const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];

      // Currency: "CRO(undefined)" → strip "(undefined)" or any parenthesized suffix
      const rawCurr = (row[currIdx] ?? "").trim();
      const currency = rawCurr.replace(/\(.*\)/, "").trim().toUpperCase();
      if (!currency) continue;

      const quantity = parseFloat((row[qtyIdx] ?? "0").replace(/,/g, ""));
      if (isNaN(quantity) || quantity === 0) continue;

      const typeStr = (row[typeIdx] ?? "").trim().toLowerCase();
      const isDeposit = typeStr === "dépôt" || typeStr === "depot" || typeStr === "deposit";
      const isWithdrawal = typeStr === "retrait" || typeStr === "withdrawal";

      const lines: CsvRecord["lines"] = [];

      if (isDeposit) {
        lines.push(...makeTransferLines("CryptoComExchange", currency, quantity));
        const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
        if (!isNaN(fee) && fee > 0) lines.push(...makeFeeLines("CryptoComExchange", currency, fee));
        records.push({ date, description: `Crypto.com Exchange deposit: ${currency}`, descriptionData: makeTransferDescriptionData("Crypto.com Exchange", currency, "deposit"), lines });
      } else if (isWithdrawal) {
        lines.push(...makeTransferLines("CryptoComExchange", currency, -quantity));
        const fee = feeIdx >= 0 ? parseFloat((row[feeIdx] ?? "0").replace(/,/g, "")) : 0;
        if (!isNaN(fee) && fee > 0) lines.push(...makeFeeLines("CryptoComExchange", currency, fee));
        records.push({ date, description: `Crypto.com Exchange withdrawal: ${currency}`, descriptionData: makeTransferDescriptionData("Crypto.com Exchange", currency, "withdrawal"), lines });
      } else {
        // Unknown type → generic
        lines.push(...makeTransferLines("CryptoComExchange", currency, quantity));
        records.push({ date, description: `Crypto.com Exchange ${typeStr}: ${currency}`, descriptionData: { type: "cex-operation", exchange: "Crypto.com Exchange", operation: typeStr, currency }, lines });
      }
    }

    return records;
  },
};
