import type { CurrencyBalance } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

export interface ConvertedSummary {
  total: number;
  baseCurrency: string;
  converted: { currency: string; amount: number; rate: number; baseAmount: number }[];
  unconverted: { currency: string; amount: number }[];
  missingDates: { currency: string; date: string }[];
}

export async function convertBalances(
  balances: CurrencyBalance[],
  baseCurrency: string,
  asOfDate: string,
): Promise<ConvertedSummary> {
  const backend = getBackend();
  let total = 0;
  const converted: ConvertedSummary["converted"] = [];
  const unconverted: ConvertedSummary["unconverted"] = [];
  const missingDates: ConvertedSummary["missingDates"] = [];

  for (const b of balances) {
    const amount = parseFloat(b.amount);
    if (b.currency === baseCurrency) {
      total += amount;
      converted.push({ currency: b.currency, amount, rate: 1, baseAmount: amount });
      continue;
    }
    const rateStr = await backend.getExchangeRate(b.currency, baseCurrency, asOfDate);
    if (rateStr) {
      const rate = parseFloat(rateStr);
      const baseAmount = amount * rate;
      total += baseAmount;
      converted.push({ currency: b.currency, amount, rate, baseAmount });
    } else {
      unconverted.push({ currency: b.currency, amount });
      missingDates.push({ currency: b.currency, date: asOfDate });
    }
  }

  return { total, baseCurrency, converted, unconverted, missingDates };
}
