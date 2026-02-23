import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";

export interface TradeRateItem {
  account_name: string;
  currency: string;
  amount: string;
}

export interface DerivedRate {
  from_currency: string; // sold
  to_currency: string; // bought
  rate: string; // |bought| / |sold|
}

/**
 * Derive an implied exchange rate from a set of journal entry line items.
 *
 * Strategy:
 * 1. Sum amounts per currency on Equity:Trading:* items only.
 *    Positive = sold, negative = bought.
 * 2. If exactly 2 currencies with non-zero sums and opposite signs → derive rate.
 * 3. Fallback: sum on Assets:* items. Negative = sold, positive = bought.
 * 4. Return null if ambiguous (>2 currencies, same signs, zeros).
 */
export function deriveTradeRate(items: TradeRateItem[]): DerivedRate | null {
  // Try Equity:Trading first
  const tradingResult = deriveFromAccounts(
    items.filter((i) => i.account_name.startsWith("Equity:Trading:")),
    true,
  );
  if (tradingResult) return tradingResult;

  // Fallback: Assets
  const assetResult = deriveFromAccounts(
    items.filter((i) => i.account_name.startsWith("Assets:")),
    false,
  );
  return assetResult;
}

function deriveFromAccounts(
  items: TradeRateItem[],
  isTrading: boolean,
): DerivedRate | null {
  if (items.length === 0) return null;

  // Sum amounts per currency
  const sums = new Map<string, Decimal>();
  for (const item of items) {
    const current = sums.get(item.currency) ?? new Decimal(0);
    sums.set(item.currency, current.plus(new Decimal(item.amount)));
  }

  // Filter out zero-sum currencies
  const nonZero = [...sums.entries()].filter(([, sum]) => !sum.isZero());
  if (nonZero.length !== 2) return null;

  const [[currA, sumA], [currB, sumB]] = nonZero;

  // For Trading: positive = sold, negative = bought
  // For Assets: negative = sold, positive = bought
  if (isTrading) {
    // Must have opposite signs
    if (sumA.isPositive() === sumB.isPositive()) return null;

    const sold = sumA.isPositive()
      ? { currency: currA, amount: sumA }
      : { currency: currB, amount: sumB };
    const bought = sumA.isNegative()
      ? { currency: currA, amount: sumA }
      : { currency: currB, amount: sumB };

    const rate = bought.amount.abs().div(sold.amount.abs());
    return {
      from_currency: sold.currency,
      to_currency: bought.currency,
      rate: rate.toString(),
    };
  } else {
    // Assets: negative = sold, positive = bought
    if (sumA.isPositive() === sumB.isPositive()) return null;

    const sold = sumA.isNegative()
      ? { currency: currA, amount: sumA }
      : { currency: currB, amount: sumB };
    const bought = sumA.isPositive()
      ? { currency: currA, amount: sumA }
      : { currency: currB, amount: sumB };

    const rate = bought.amount.abs().div(sold.amount.abs());
    return {
      from_currency: sold.currency,
      to_currency: bought.currency,
      rate: rate.toString(),
    };
  }
}

/**
 * Derive an exchange rate from trade items and record it in the backend.
 * Returns the derived rate if successful, null otherwise.
 */
export async function deriveAndRecordTradeRate(
  backend: Backend,
  date: string,
  items: TradeRateItem[],
): Promise<DerivedRate | null> {
  const derived = deriveTradeRate(items);
  if (!derived) return null;

  await backend.recordExchangeRate({
    id: uuidv7(),
    date,
    from_currency: derived.from_currency,
    to_currency: derived.to_currency,
    rate: derived.rate,
    source: "transaction",
  });

  return derived;
}
