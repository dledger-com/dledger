/**
 * French crypto tax computation engine — Art. 150 VH bis CGI.
 *
 * Uses the portfolio-wide weighted average formula:
 *   Plus-value = C - (A * C / V)
 *
 * Where:
 *   C = net fiat received from a crypto-to-fiat sale (EUR)
 *   A = cumulative total fiat spent on crypto, adjusted after each sale
 *   V = EUR value of the entire crypto portfolio at the moment of sale
 *
 * Only crypto-to-fiat dispositions are taxable. Crypto-to-crypto swaps are NOT.
 */
import Decimal from "decimal.js-light";
import type { Backend } from "$lib/backend.js";
import type { Account, JournalEntry, LineItem, TrialBalance } from "$lib/types/index.js";
import { ExchangeRateCache } from "./exchange-rate-cache.js";

// ---------- Default fiat currencies ----------

export const DEFAULT_FIAT_CURRENCIES = new Set([
  "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "HRK",
]);

// ---------- Types ----------

export interface FrenchTaxOptions {
  taxYear: number;
  priorAcquisitionCost: string; // EUR — crypto bought before dledger data
  fiatCurrencies?: string[];     // override DEFAULT_FIAT_CURRENCIES
  baseCurrency?: string;         // for non-EUR fiat conversions, default "EUR"
}

export interface Disposition {
  entryId: string;
  date: string;
  description: string;
  /** Crypto currencies disposed in this event. */
  cryptoCurrencies: string[];
  /** C: net fiat received in EUR. */
  fiatReceived: string;
  /** V: EUR value of entire crypto portfolio at moment of sale. */
  portfolioValue: string;
  /** A: acquisition cost before this sale. */
  acquisitionCostBefore: string;
  /** A * C / V: cost fraction attributable to this sale. */
  costFraction: string;
  /** Plus-value = C - costFraction. */
  plusValue: string;
  /** A after this sale = A - costFraction. */
  acquisitionCostAfter: string;
}

export interface Acquisition {
  entryId: string;
  date: string;
  description: string;
  /** Fiat amount spent in EUR. */
  fiatSpent: string;
  /** Crypto currencies acquired. */
  cryptoCurrencies: string[];
}

export interface FrenchTaxReport {
  taxYear: number;
  dispositions: Disposition[];
  acquisitions: Acquisition[];
  /** Total plus-value for the year. */
  totalPlusValue: string;
  /** Total fiat received (sum of C across dispositions). */
  totalFiatReceived: string;
  /** Final A at year-end. */
  finalAcquisitionCost: string;
  /** EUR value of crypto portfolio at Dec 31. */
  yearEndPortfolioValue: string;
  /** Box 3AN (if positive) or 3BN (if negative). */
  box3AN: string;
  box3BN: string;
  /** Whether total <= 305 EUR exemption threshold. */
  isExempt: boolean;
  /** Tax at PFU 30%. */
  taxDuePFU30: string;
  /** Tax at PFU 31.4% (social contributions included). */
  taxDuePFU314: string;
  warnings: string[];
  /** Structured missing rate data for inline backfill. */
  missingCurrencyDates: { currency: string; date: string }[];
}

// ---------- Internal types ----------

interface EntryEvent {
  type: "acquisition" | "disposition" | "none";
  fiatAmountEUR: Decimal;
  cryptoCurrencies: string[];
  entry: JournalEntry;
}

// ---------- Classification ----------

/**
 * Analyze a journal entry's line items to detect crypto-to-fiat dispositions
 * or fiat-to-crypto acquisitions.
 */
export function classifyEntryEvent(
  entry: JournalEntry,
  items: LineItem[],
  accountMap: Map<string, Account>,
  fiatSet: Set<string>,
): EntryEvent {
  if (entry.status !== "confirmed") {
    return { type: "none", fiatAmountEUR: new Decimal(0), cryptoCurrencies: [], entry };
  }

  let fiatIn = new Decimal(0);   // fiat coming into asset accounts (= crypto sold for fiat)
  let fiatOut = new Decimal(0);  // fiat leaving asset accounts (= fiat spent on crypto)
  const cryptoCurrenciesIn = new Set<string>();
  const cryptoCurrenciesOut = new Set<string>();

  for (const item of items) {
    const account = accountMap.get(item.account_id);
    if (!account || account.account_type !== "asset") continue;
    const amount = new Decimal(item.amount);
    const isFiat = fiatSet.has(item.currency);

    if (isFiat) {
      // Fiat in asset account: positive = fiat received, negative = fiat spent
      if (amount.gt(0)) {
        fiatIn = fiatIn.plus(amount);
      } else {
        fiatOut = fiatOut.plus(amount.abs());
      }
    } else {
      // Crypto in asset account: positive = acquired, negative = disposed
      if (amount.gt(0)) {
        cryptoCurrenciesIn.add(item.currency);
      } else {
        cryptoCurrenciesOut.add(item.currency);
      }
    }
  }

  const hasCryptoOut = cryptoCurrenciesOut.size > 0;
  const hasCryptoIn = cryptoCurrenciesIn.size > 0;
  const hasFiatIn = fiatIn.gt(0);
  const hasFiatOut = fiatOut.gt(0);

  // Disposition: crypto goes out AND fiat comes in
  if (hasCryptoOut && hasFiatIn) {
    return {
      type: "disposition",
      fiatAmountEUR: fiatIn,
      cryptoCurrencies: [...cryptoCurrenciesOut],
      entry,
    };
  }

  // Acquisition: fiat goes out AND crypto comes in
  if (hasCryptoIn && hasFiatOut) {
    return {
      type: "acquisition",
      fiatAmountEUR: fiatOut,
      cryptoCurrencies: [...cryptoCurrenciesIn],
      entry,
    };
  }

  // Crypto-to-crypto or unrelated → no taxable event
  return { type: "none", fiatAmountEUR: new Decimal(0), cryptoCurrencies: [], entry };
}

// ---------- Portfolio valuation ----------

/**
 * Compute the EUR value of all crypto holdings from a trial balance.
 * Returns { value, missingRates }.
 */
export async function computePortfolioValueEUR(
  trialBalance: TrialBalance,
  fiatSet: Set<string>,
  rateCache: ExchangeRateCache,
  date: string,
  baseCurrency: string,
): Promise<{ value: Decimal; missingRates: string[]; missingCurrencyDates: { currency: string; date: string }[] }> {
  let value = new Decimal(0);
  const missingRates: string[] = [];
  const missingCurrencyDates: { currency: string; date: string }[] = [];

  for (const line of trialBalance.lines) {
    // Only count asset-type accounts
    if (line.account_type !== "asset") continue;

    for (const bal of line.balances) {
      if (fiatSet.has(bal.currency)) continue; // Skip fiat
      const amount = new Decimal(bal.amount);
      if (amount.lte(0)) continue; // Only positive holdings

      if (bal.currency === baseCurrency) {
        value = value.plus(amount);
        continue;
      }

      const rateStr = await rateCache.get(bal.currency, baseCurrency, date);
      if (rateStr) {
        value = value.plus(amount.times(new Decimal(rateStr)));
      } else {
        missingRates.push(`${bal.currency}/${baseCurrency} on ${date}`);
        missingCurrencyDates.push({ currency: bal.currency, date });
      }
    }
  }

  return { value, missingRates, missingCurrencyDates };
}

// ---------- Main algorithm ----------

export async function computeFrenchTaxReport(
  backend: Backend,
  opts: FrenchTaxOptions,
): Promise<FrenchTaxReport> {
  const baseCurrency = opts.baseCurrency ?? "EUR";
  const fiatSet = opts.fiatCurrencies
    ? new Set(opts.fiatCurrencies)
    : new Set(DEFAULT_FIAT_CURRENCIES);
  const warnings: string[] = [];
  const missingCurrencyDates: { currency: string; date: string }[] = [];

  // 1. Load all accounts into a map
  const accounts = await backend.listAccounts();
  const accountMap = new Map<string, Account>();
  for (const acc of accounts) {
    accountMap.set(acc.id, acc);
  }

  // 2. Query ALL confirmed entries from beginning of time through end of tax year
  const yearEnd = `${opts.taxYear}-12-31`;
  const yearStart = `${opts.taxYear}-01-01`;
  const allEntries = await backend.queryJournalEntries({
    to_date: yearEnd,
    status: "confirmed",
  });

  // Sort chronologically (by date, then by entry creation order)
  allEntries.sort((a, b) => {
    const dateCompare = a[0].date.localeCompare(b[0].date);
    if (dateCompare !== 0) return dateCompare;
    return a[0].created_at.localeCompare(b[0].created_at);
  });

  // 3. Process entries: build running A, collect dispositions/acquisitions
  let A = new Decimal(opts.priorAcquisitionCost || "0");
  const rateCache = new ExchangeRateCache(backend);
  const dispositions: Disposition[] = [];
  const acquisitions: Acquisition[] = [];

  // Cache trial balances by date to avoid repeated queries
  const trialBalanceCache = new Map<string, TrialBalance>();

  async function getTrialBalance(date: string): Promise<TrialBalance> {
    let tb = trialBalanceCache.get(date);
    if (!tb) {
      tb = await backend.trialBalance(date);
      trialBalanceCache.set(date, tb);
    }
    return tb;
  }

  for (const [entry, items] of allEntries) {
    const event = classifyEntryEvent(entry, items, accountMap, fiatSet);

    if (event.type === "acquisition") {
      // Convert to EUR if not already
      let fiatEUR = event.fiatAmountEUR;
      // The fiat might be in USD or other; we need EUR
      // Check what fiat currency was actually used
      const fiatCurrencyUsed = findFiatCurrency(items, accountMap, fiatSet, "out");
      if (fiatCurrencyUsed && fiatCurrencyUsed !== baseCurrency) {
        const rate = await rateCache.get(fiatCurrencyUsed, baseCurrency, entry.date);
        if (rate) {
          fiatEUR = fiatEUR.times(new Decimal(rate));
        } else {
          warnings.push(`Missing ${fiatCurrencyUsed}/${baseCurrency} rate on ${entry.date} for acquisition`);
          missingCurrencyDates.push({ currency: fiatCurrencyUsed, date: entry.date });
        }
      }

      A = A.plus(fiatEUR);

      if (entry.date >= yearStart) {
        acquisitions.push({
          entryId: entry.id,
          date: entry.date,
          description: entry.description,
          fiatSpent: fiatEUR.toFixed(2),
          cryptoCurrencies: event.cryptoCurrencies,
        });
      }
    } else if (event.type === "disposition") {
      // Convert fiat to EUR if not already
      let C = event.fiatAmountEUR;
      const fiatCurrencyUsed = findFiatCurrency(items, accountMap, fiatSet, "in");
      if (fiatCurrencyUsed && fiatCurrencyUsed !== baseCurrency) {
        const rate = await rateCache.get(fiatCurrencyUsed, baseCurrency, entry.date);
        if (rate) {
          C = C.times(new Decimal(rate));
        } else {
          warnings.push(`Missing ${fiatCurrencyUsed}/${baseCurrency} rate on ${entry.date} for disposition`);
          missingCurrencyDates.push({ currency: fiatCurrencyUsed, date: entry.date });
        }
      }

      // Get portfolio value V at moment of sale
      const tb = await getTrialBalance(entry.date);
      const { value: V, missingRates, missingCurrencyDates: pvMissing } = await computePortfolioValueEUR(
        tb, fiatSet, rateCache, entry.date, baseCurrency,
      );
      for (const mr of missingRates) {
        warnings.push(`Missing rate: ${mr}`);
      }
      missingCurrencyDates.push(...pvMissing);

      // Only record dispositions within the tax year
      if (entry.date >= yearStart) {
        if (V.isZero()) {
          warnings.push(`Portfolio value is 0 on ${entry.date} — cannot compute plus-value for entry ${entry.description}`);
          // Still update A if needed
        } else {
          // Apply formula: PV = C - (A * C / V)
          const costFraction = V.gt(0) ? A.times(C).div(V) : new Decimal(0);
          // Cap costFraction at A (when V < C edge case)
          const cappedFraction = costFraction.gt(A) ? A : costFraction;
          const plusValue = C.minus(cappedFraction);
          const Aafter = A.minus(cappedFraction);
          // Clamp A to 0
          const newA = Aafter.lt(0) ? new Decimal(0) : Aafter;

          dispositions.push({
            entryId: entry.id,
            date: entry.date,
            description: entry.description,
            cryptoCurrencies: event.cryptoCurrencies,
            fiatReceived: C.toFixed(2),
            portfolioValue: V.toFixed(2),
            acquisitionCostBefore: A.toFixed(2),
            costFraction: cappedFraction.toFixed(2),
            plusValue: plusValue.toFixed(2),
            acquisitionCostAfter: newA.toFixed(2),
          });

          A = newA;
        }
      } else {
        // Pre-year disposition: still update A
        if (!V.isZero()) {
          const costFraction = A.times(C).div(V);
          const cappedFraction = costFraction.gt(A) ? A : costFraction;
          const Aafter = A.minus(cappedFraction);
          A = Aafter.lt(0) ? new Decimal(0) : Aafter;
        }
      }
    }
  }

  // 4. Compute totals
  let totalPlusValue = new Decimal(0);
  let totalFiatReceived = new Decimal(0);
  for (const d of dispositions) {
    totalPlusValue = totalPlusValue.plus(new Decimal(d.plusValue));
    totalFiatReceived = totalFiatReceived.plus(new Decimal(d.fiatReceived));
  }

  // 5. Compute end-of-year portfolio value
  const yearEndDate = `${opts.taxYear + 1}-01-01`; // trial balance as-of is exclusive
  const yearEndTb = await getTrialBalance(yearEndDate);
  const { value: yearEndV, missingRates: yearEndMissing, missingCurrencyDates: yearEndMissingCd } = await computePortfolioValueEUR(
    yearEndTb, fiatSet, rateCache, yearEnd, baseCurrency,
  );
  for (const mr of yearEndMissing) {
    warnings.push(`Missing rate for year-end portfolio: ${mr}`);
  }
  missingCurrencyDates.push(...yearEndMissingCd);

  // 6. Build report
  const isPositive = totalPlusValue.gte(0);
  const totalDispositions = totalFiatReceived;
  const isExempt = totalDispositions.lte(305);

  return {
    taxYear: opts.taxYear,
    dispositions,
    acquisitions,
    totalPlusValue: totalPlusValue.toFixed(2),
    totalFiatReceived: totalFiatReceived.toFixed(2),
    finalAcquisitionCost: A.toFixed(2),
    yearEndPortfolioValue: yearEndV.toFixed(2),
    box3AN: isPositive ? totalPlusValue.toFixed(2) : "0.00",
    box3BN: isPositive ? "0.00" : totalPlusValue.abs().toFixed(2),
    isExempt,
    taxDuePFU30: isPositive && !isExempt
      ? totalPlusValue.times(new Decimal("0.30")).toFixed(2)
      : "0.00",
    taxDuePFU314: isPositive && !isExempt
      ? totalPlusValue.times(new Decimal("0.314")).toFixed(2)
      : "0.00",
    warnings,
    missingCurrencyDates,
  };
}

// ---------- Helpers ----------

/**
 * Find the primary fiat currency used in an entry.
 * direction: "in" = fiat received (disposition), "out" = fiat spent (acquisition)
 */
function findFiatCurrency(
  items: LineItem[],
  accountMap: Map<string, Account>,
  fiatSet: Set<string>,
  direction: "in" | "out",
): string | null {
  for (const item of items) {
    if (!fiatSet.has(item.currency)) continue;
    const account = accountMap.get(item.account_id);
    if (!account || account.account_type !== "asset") continue;
    const amount = new Decimal(item.amount);

    if (direction === "in" && amount.gt(0)) return item.currency;
    if (direction === "out" && amount.lt(0)) return item.currency;
  }
  return null;
}
