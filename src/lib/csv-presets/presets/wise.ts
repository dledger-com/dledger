import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { bankDescription, renderDescription } from "$lib/types/description-data.js";
import { parseAmount, detectNumberFormat } from "../parse-amount.js";
import { matchRule, type CsvCategorizationRule } from "../categorize.js";
import { bankAssets, bankFees, EQUITY_TRADING, EXPENSES_UNCATEGORIZED, INCOME_UNCATEGORIZED } from "$lib/accounts/paths.js";

let _rules: CsvCategorizationRule[] = [];

export function setWiseRules(rules: CsvCategorizationRule[]): void {
  _rules = rules;
}

/** Parse Wise dates: "DD-MM-YYYY" → "YYYY-MM-DD" */
export function parseWiseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const y = parseInt(yyyy), mo = parseInt(mm), d = parseInt(dd);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const daysInMonth = new Date(y, mo, 0).getDate();
  if (d > daysInMonth) return null;
  return `${yyyy}-${mm}-${dd}`;
}

const WISE_REQUIRED = ["transferwise id", "amount", "currency", "transaction details type"];

export const wisePreset: CsvPreset = {
  id: "wise",
  name: "Wise (TransferWise)",
  description: "Wise (formerly TransferWise) statement CSV export with TransferWise ID, Amount, Currency, Transaction Details Type.",
  suggestedMainAccount: bankAssets("Wise"),

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const hasAll = WISE_REQUIRED.every((r) => lower.includes(r));
    if (!hasAll) return 0;
    // "TransferWise ID" is uniquely identifying
    return lower.includes("transferwise id") ? 90 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    return {
      dateColumn: "Date",
      descriptionColumn: "Description",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const idx = lower.indexOf(name.toLowerCase());
      return idx >= 0 ? idx : -1;
    };

    const dateIdx = col("Date");
    const amtIdx = col("Amount");
    const currIdx = col("Currency");
    const descIdx = col("Description");
    const idIdx = col("TransferWise ID");
    const detailsTypeIdx = col("Transaction Details Type");
    const merchantIdx = col("Merchant");
    const exchangeFromIdx = col("Exchange From");
    const exchangeToIdx = col("Exchange To");
    const exchangeRateIdx = col("Exchange Rate");
    const exchangeToAmountIdx = col("Exchange To Amount");
    const paymentRefIdx = col("Payment Reference");
    const cardLastFourIdx = col("Card Last Four Digits");
    const totalFeesIdx = col("Total fees");
    const payeeNameIdx = col("Payee Name");
    const payerNameIdx = col("Payer Name");

    if (dateIdx === -1 || amtIdx === -1 || currIdx === -1) return null;

    // Detect number format from amount samples
    const amtSamples = rows.slice(0, 20).map((r) => r[amtIdx] ?? "").filter(Boolean);
    const { european } = detectNumberFormat(amtSamples);

    const records: CsvRecord[] = [];

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

      const rawDate = row[dateIdx] ?? "";
      const date = parseWiseDate(rawDate);
      if (!date) continue;

      const amount = parseAmount(row[amtIdx] ?? "", european);
      if (amount === null || amount === 0) continue;

      const currency = (row[currIdx] ?? "").trim().toUpperCase();
      if (!currency) continue;

      const description = descIdx >= 0 ? (row[descIdx] ?? "").trim() : "";
      const detailsType = detailsTypeIdx >= 0 ? (row[detailsTypeIdx] ?? "").trim().toUpperCase() : "";
      const sourceKey = idIdx >= 0 ? (row[idIdx] ?? "").trim() : undefined;

      const paymentRef = paymentRefIdx >= 0 ? (row[paymentRefIdx] ?? "").trim() : "";
      const payeeName = payeeNameIdx >= 0 ? (row[payeeNameIdx] ?? "").trim() : "";
      const payerName = payerNameIdx >= 0 ? (row[payerNameIdx] ?? "").trim() : "";
      const merchant = merchantIdx >= 0 ? (row[merchantIdx] ?? "").trim() : "";

      // Build metadata
      const metadata: Record<string, string> = {};
      if (paymentRef) metadata["payment-reference"] = paymentRef;
      if (payeeName) metadata["payee"] = payeeName;
      if (payerName) metadata["payer"] = payerName;
      if (cardLastFourIdx >= 0 && row[cardLastFourIdx]?.trim()) {
        metadata["card-last-four"] = row[cardLastFourIdx]!.trim();
      }

      let lines: CsvRecord["lines"];
      let descText: string;

      if (detailsType === "CONVERSION") {
        const result = buildConversionLines(row, amount, currency, european, {
          exchangeFromIdx, exchangeToIdx, exchangeRateIdx, exchangeToAmountIdx,
        });
        if (!result) continue;
        lines = result.lines;
        descText = result.descText;
        if (result.exchangeFrom) metadata["exchange-from"] = result.exchangeFrom;
        if (result.exchangeTo) metadata["exchange-to"] = result.exchangeTo;
        if (result.exchangeRate) metadata["exchange-rate"] = result.exchangeRate;
      } else if (detailsType === "CARD") {
        descText = merchant || description || "Card payment";
        const mainAccount = bankAssets("Wise", currency);
        const rule = matchRule(descText, _rules);
        const counterAccount = rule ? rule.account : EXPENSES_UNCATEGORIZED;
        lines = [
          { account: mainAccount, currency, amount: amount.toString() },
          { account: counterAccount, currency, amount: (-amount).toString() },
        ];
      } else {
        // TRANSFER, DIRECT_DEBIT, MONEY_ADDED, and other types
        descText = buildTransferDescription(description, payeeName, payerName, amount);
        const mainAccount = bankAssets("Wise", currency);
        const rule = matchRule(descText, _rules);
        const counterAccount = rule
          ? rule.account
          : amount < 0 ? EXPENSES_UNCATEGORIZED : INCOME_UNCATEGORIZED;
        lines = [
          { account: mainAccount, currency, amount: amount.toString() },
          { account: counterAccount, currency, amount: (-amount).toString() },
        ];
      }

      // Fee line items
      if (totalFeesIdx >= 0) {
        const feeRaw = (row[totalFeesIdx] ?? "").trim();
        if (feeRaw) {
          const fee = parseAmount(feeRaw, european);
          if (fee !== null && fee > 0) {
            const mainAccount = bankAssets("Wise", currency);
            lines.push(
              { account: bankFees("Wise"), currency, amount: fee.toString() },
              { account: mainAccount, currency, amount: (-fee).toString() },
            );
            metadata["total-fees"] = feeRaw;
          }
        }
      }

      const descData = bankDescription("Wise", descText, paymentRef || undefined);
      records.push({
        date,
        description: renderDescription(descData),
        descriptionData: descData,
        lines,
        sourceKey: sourceKey || undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    return records;
  },
};

// ── Helpers ──────────────────────────────────────────────

interface ConversionIndices {
  exchangeFromIdx: number;
  exchangeToIdx: number;
  exchangeRateIdx: number;
  exchangeToAmountIdx: number;
}

interface ConversionResult {
  lines: CsvRecord["lines"];
  descText: string;
  exchangeFrom: string;
  exchangeTo: string;
  exchangeRate: string;
}

function buildConversionLines(
  row: string[],
  amount: number,
  currency: string,
  european: boolean,
  idx: ConversionIndices,
): ConversionResult | null {
  const exchangeFrom = idx.exchangeFromIdx >= 0 ? (row[idx.exchangeFromIdx] ?? "").trim().toUpperCase() : "";
  const exchangeTo = idx.exchangeToIdx >= 0 ? (row[idx.exchangeToIdx] ?? "").trim().toUpperCase() : "";
  const exchangeRateRaw = idx.exchangeRateIdx >= 0 ? (row[idx.exchangeRateIdx] ?? "").trim() : "";
  const exchangeToAmountRaw = idx.exchangeToAmountIdx >= 0 ? (row[idx.exchangeToAmountIdx] ?? "").trim() : "";

  if (!exchangeFrom || !exchangeTo) return null;

  const exchangeRate = parseFloat(exchangeRateRaw);
  const exchangeToAmount = parseAmount(exchangeToAmountRaw, european);

  // Determine from/to amounts and currencies
  let fromCurrency: string;
  let fromAmount: number;
  let toCurrency: string;
  let toAmount: number;

  if (amount < 0) {
    // Outflow: selling this currency
    fromCurrency = currency;
    fromAmount = Math.abs(amount);
    toCurrency = exchangeTo;
    toAmount = exchangeToAmount ?? (Number.isFinite(exchangeRate) ? fromAmount * exchangeRate : 0);
  } else {
    // Inflow: bought this currency
    toCurrency = currency;
    toAmount = amount;
    fromCurrency = exchangeFrom;
    // Derive from-amount: to_amount / rate (rate is from→to)
    fromAmount = exchangeToAmount !== null && exchangeToAmount > 0 && Number.isFinite(exchangeRate) && exchangeRate > 0
      ? toAmount / exchangeRate
      : toAmount;
  }

  if (fromAmount <= 0 || toAmount <= 0) return null;

  // Multi-currency trade with equity balancing (same pattern as makeTradeLines)
  const lines: CsvRecord["lines"] = [
    { account: bankAssets("Wise", fromCurrency), currency: fromCurrency, amount: (-fromAmount).toString() },
    { account: bankAssets("Wise", toCurrency), currency: toCurrency, amount: toAmount.toString() },
    { account: EQUITY_TRADING, currency: fromCurrency, amount: fromAmount.toString() },
    { account: EQUITY_TRADING, currency: toCurrency, amount: (-toAmount).toString() },
  ];

  return {
    lines,
    descText: `Convert ${fromCurrency} \u2192 ${toCurrency}`,
    exchangeFrom,
    exchangeTo,
    exchangeRate: exchangeRateRaw,
  };
}

function buildTransferDescription(
  description: string,
  payeeName: string,
  payerName: string,
  amount: number,
): string {
  if (description) return description;
  const counterparty = amount < 0 ? payeeName : payerName;
  if (counterparty) return `Transfer ${amount < 0 ? "to" : "from"} ${counterparty}`;
  return "Wise transaction";
}
