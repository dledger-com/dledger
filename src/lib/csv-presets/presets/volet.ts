import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { colIdx, makeTradeLines, makeTradeDescription, makeTradeDescriptionData, makeTransferDescriptionData, makeTransferLines, makeFeeLines } from "./shared.js";
import { exchangeAssets } from "$lib/accounts/paths.js";

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse "05 Mar 2026, 13:18" → "2026-03-05" */
export function parseVoletDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return null;
  const month = MONTH_MAP[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

/** Handle "sep=," first-line Excel hint by shifting headers/rows */
function getRealHeaders(headers: string[], rows: string[][]): { h: string[]; data: string[][] } {
  if (headers.length <= 2 && (headers[0] ?? "").startsWith("sep=")) {
    return { h: rows[0] ?? [], data: rows.slice(1) };
  }
  return { h: headers, data: rows };
}

function hasVoletHeaders(h: string[]): boolean {
  const lower = h.map((c) => c.trim().toLowerCase());
  return lower.includes("transaction type") && lower.includes("direction") && lower.includes("pays fee");
}

export const voletPreset: CsvPreset = {
  id: "volet",
  name: "Volet",
  description: "Volet (AdvCash) transaction history CSV export.",
  suggestedMainAccount: exchangeAssets("Volet"),

  detect(headers: string[], sampleRows: string[][]): number {
    if (hasVoletHeaders(headers)) return 85;
    // "sep=" prefix shifts real headers into sampleRows[0]
    if (headers.length <= 2 && (headers[0] ?? "").startsWith("sep=") && sampleRows.length > 0) {
      if (hasVoletHeaders(sampleRows[0])) return 85;
    }
    return 0;
  },

  getDefaultMapping(): Partial<CsvImportOptions> {
    return { dateColumn: "Date, UTC" };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const { h, data } = getRealHeaders(headers, rows);
    if (!hasVoletHeaders(h)) return null;

    const dateIdx = colIdx(h, "Date, UTC");
    const idIdx = colIdx(h, "Id");
    const typeIdx = colIdx(h, "Transaction Type");
    const dirIdx = colIdx(h, "Direction");
    const statusIdx = colIdx(h, "Status");
    const debitIdx = colIdx(h, "Debit");
    const debitCurrIdx = debitIdx >= 0 ? debitIdx + 1 : -1;
    const creditIdx = colIdx(h, "Credit");
    const creditCurrIdx = creditIdx >= 0 ? creditIdx + 1 : -1;
    const commIdx = colIdx(h, "Commission");
    const commCurrIdx = commIdx >= 0 ? commIdx + 1 : -1;

    if ([dateIdx, typeIdx, dirIdx, statusIdx].some((i) => i === -1)) return null;

    const records: CsvRecord[] = [];

    for (const row of data) {
      if (row.length <= 1 && (row[0] ?? "") === "") continue;

      const status = (row[statusIdx] ?? "").trim();
      if (status === "Canceled") continue;

      const date = parseVoletDate(row[dateIdx] ?? "");
      if (!date) continue;

      const id = (row[idIdx] ?? "").trim();
      const type = (row[typeIdx] ?? "").trim();
      const direction = (row[dirIdx] ?? "").trim().toUpperCase();

      const debit = debitIdx >= 0 ? parseFloat(row[debitIdx] ?? "0") : 0;
      const debitCurr = debitCurrIdx >= 0 ? (row[debitCurrIdx] ?? "").trim().toUpperCase() : "";
      const credit = creditIdx >= 0 ? parseFloat(row[creditIdx] ?? "0") : 0;
      const creditCurr = creditCurrIdx >= 0 ? (row[creditCurrIdx] ?? "").trim().toUpperCase() : "";
      const comm = commIdx >= 0 ? parseFloat(row[commIdx] ?? "0") : 0;
      const commCurr = commCurrIdx >= 0 ? (row[commCurrIdx] ?? "").trim().toUpperCase() : "";

      const lines: CsvRecord["lines"] = [];
      let desc = "";
      let descData: import("$lib/types/description-data.js").DescriptionData | undefined;

      if (direction === "INNER_TRANSACTION") {
        if (isNaN(credit) || isNaN(debit) || !creditCurr || !debitCurr) continue;
        lines.push(...makeTradeLines("Volet", creditCurr, debitCurr, "BUY", credit, debit));
        desc = makeTradeDescription("Volet", creditCurr, debitCurr, "BUY");
        descData = makeTradeDescriptionData("Volet", creditCurr, debitCurr, "BUY");
      } else if (direction === "DEPOSIT") {
        if (isNaN(credit) || !creditCurr) continue;
        lines.push(...makeTransferLines("Volet", creditCurr, credit));
        desc = `Volet deposit: ${creditCurr}`;
        descData = makeTransferDescriptionData("Volet", creditCurr, "deposit");
      } else if (direction === "WITHDRAWAL") {
        if (isNaN(debit) || !debitCurr) continue;
        lines.push(...makeTransferLines("Volet", debitCurr, -debit));
        desc = `Volet withdrawal: ${debitCurr}`;
        descData = makeTransferDescriptionData("Volet", debitCurr, "withdrawal");
      } else {
        continue;
      }

      if (!isNaN(comm) && comm > 0 && commCurr) {
        lines.push(...makeFeeLines("Volet", commCurr, comm));
      }

      records.push({ date, description: desc, descriptionData: descData, lines, sourceKey: id });
    }

    return records;
  },
};
