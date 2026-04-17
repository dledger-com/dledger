import type { QifProfileExtension } from "$lib/plugins/types.js";
import type { CsvRecord } from "$lib/csv-presets/types.js";
import type { QifSection, QifParseResult } from "../parse-qif.js";
import { bankAssets, EQUITY_TRADING } from "$lib/accounts/paths.js";
import { tradeDescription, renderDescription } from "$lib/types/description-data.js";

/**
 * Wise QIF filename pattern:
 *   statement_153951776_THB_2020-01-01_2026-04-17.qif
 *              ^id       ^currency ^from      ^to
 */
const WISE_FILENAME_RE = /^statement_\d+_([A-Z]{3})_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.qif$/i;

/**
 * Wise conversion pattern (appears in description via payee):
 *   "Converted 125.00 EUR to 4,686.10 THB"
 */
const CONVERSION_RE = /Converted\s+([\d,.]+)\s+([A-Z]{3,5})\s+to\s+([\d,.]+)\s+([A-Z]{3,5})/i;

/**
 * Wise conversion rate pattern (appears in description via memo):
 *   "EUR-THB rate 37.7668000000000000"
 */
const RATE_RE = /([A-Z]{3,5})-([A-Z]{3,5})\s+rate\s+([\d.]+)/i;

/** Parse a Wise-formatted amount: "4,686.10" or "125.00" */
function parseWiseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export const wiseQifProfile: QifProfileExtension = {
  id: "qif-wise",
  name: "Wise (TransferWise)",
  presetId: "qif-wise",

  detectFilename(filename: string): number {
    return WISE_FILENAME_RE.test(filename) ? 90 : 0;
  },

  detectContent(result: QifParseResult): number {
    let hits = 0;
    for (const section of result.sections) {
      for (const tx of section.transactions) {
        if (tx.payee && CONVERSION_RE.test(tx.payee)) hits++;
        if (tx.memo && RATE_RE.test(tx.memo)) hits++;
        if (hits >= 2) return 70;
      }
    }
    return hits > 0 ? 50 : 0;
  },

  extractCurrency(filename: string): string | null {
    const m = filename.match(WISE_FILENAME_RE);
    return m ? m[1].toUpperCase() : null;
  },

  suggestAccount(_section: QifSection, filename: string): string {
    const currency = this.extractCurrency!(filename);
    return currency ? bankAssets("Wise", currency) : bankAssets("Wise");
  },

  transformRecords(records: CsvRecord[]): CsvRecord[] {
    // Match on record description — the payee+memo text is embedded there.
    // This avoids index misalignment when convertQifToRecords skips invalid transactions.
    return records.map((rec) => {
      const convMatch = rec.description.match(CONVERSION_RE);
      if (!convMatch) return rec;

      const fromAmount = parseWiseAmount(convMatch[1]);
      const fromCurrency = convMatch[2].toUpperCase();
      const toAmount = parseWiseAmount(convMatch[3]);
      const toCurrency = convMatch[4].toUpperCase();

      if (fromAmount === null || toAmount === null || fromAmount <= 0 || toAmount <= 0) return rec;

      // Build multi-currency trade with equity balancing (same pattern as Wise CSV preset)
      const lines: CsvRecord["lines"] = [
        { account: bankAssets("Wise", fromCurrency), currency: fromCurrency, amount: (-fromAmount).toString() },
        { account: bankAssets("Wise", toCurrency), currency: toCurrency, amount: toAmount.toString() },
        { account: EQUITY_TRADING, currency: fromCurrency, amount: fromAmount.toString() },
        { account: EQUITY_TRADING, currency: toCurrency, amount: (-toAmount).toString() },
      ];

      // Parse rate from memo portion of description
      const metadata: Record<string, string> = { ...rec.metadata };
      const rateMatch = rec.description.match(RATE_RE);
      if (rateMatch) {
        metadata["exchange-rate"] = rateMatch[3];
        metadata["exchange-from"] = rateMatch[1].toUpperCase();
        metadata["exchange-to"] = rateMatch[2].toUpperCase();
      }

      const descData = tradeDescription("Wise", `${fromAmount} ${fromCurrency}`, `${toAmount} ${toCurrency}`);

      return {
        ...rec,
        description: renderDescription(descData),
        descriptionData: descData,
        lines,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    });
  },
};
