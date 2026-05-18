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
import type { Account, JournalEntry, LineItem, TrialBalance, TrialBalanceLine, CurrencyBalance } from "$lib/types/index.js";
import { ExchangeRateCache } from "./exchange-rate-cache.js";
import { isValidCurrencyCode } from "$lib/currency-validation.js";

// ---------- Default fiat currencies ----------

export const DEFAULT_FIAT_CURRENCIES = new Set([
  "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "HRK",
]);

// ---------- Types ----------

export interface FrenchTaxOptions {
  taxYear: number;
  priorAcquisitionCost: string; // EUR — crypto bought before dledger data
  priorCostSource?: 'chained' | 'initial' | 'none'; // how priorAcquisitionCost was resolved
  fiatCurrencies?: string[];     // override DEFAULT_FIAT_CURRENCIES
  baseCurrency?: string;         // for non-EUR fiat conversions, default "EUR"
  /** When true (default), every sale on the same calendar date is rolled into
   *  a single aggregate cession before the formula is applied. Cuts the number
   *  of rows the user has to copy onto form 2086 dramatically. */
  groupSameDaySales?: boolean;
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
  /** The value of A the engine started with for this report — captures
   *  opts.priorAcquisitionCost verbatim so downstream UI can detect when the
   *  current setting has drifted from the value used at generation time.
   *  Optional for backward compat with reports persisted before this field existed. */
  priorAcquisitionCost?: string;
  /** Whether same-day sales were aggregated into a single cession for this report.
   *  Optional for backward compat (undefined on reports persisted before this option). */
  groupSameDaySales?: boolean;
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
  /** Number of in-year dispositions skipped because portfolio value was 0. */
  skippedDispositionCount: number;
  /** Structured missing rate data for inline backfill. */
  missingCurrencyDates: { currency: string; date: string }[];
  /** Number of entries processed from the journal. */
  entriesProcessed: number;
  /** Number of pre-year acquisitions detected (before taxYear). */
  preYearAcquisitionCount: number;
  /** Total EUR value of pre-year acquisitions. */
  preYearAcquisitionTotal: string;
  /** Number of pre-year dispositions detected. */
  preYearDispositionCount: number;
  /** Total EUR fiat received across pre-year dispositions. */
  preYearDispositionTotal: string;
  /** Sample pre-year dispositions for debug inspection (first 20). */
  preYearDispositionSamples: { date: string; description: string; fiatReceived: string; cryptoCurrencies: string[] }[];
  /** Year-end crypto holdings aggregated by currency (debug). */
  yearEndCryptoHoldings: { currency: string; amount: string; accounts: { name: string; amount: string }[] }[];
}

export interface PersistedFrenchTaxReport {
  generatedAt: string;
  finalAcquisitionCost: string;
  report: FrenchTaxReport;
  checklist: Record<string, boolean>;
}

export function resolvePriorAcquisitionCost(
  taxYear: number,
  initialCost: string,
  persistedYears: Map<number, string>,
): { value: string; source: 'chained' | 'initial' | 'none'; sourceYear?: number } {
  const prevYear = taxYear - 1;
  const chained = persistedYears.get(prevYear);
  if (chained !== undefined) {
    return { value: chained, source: 'chained', sourceYear: prevYear };
  }
  if (initialCost && initialCost !== '0') {
    return { value: initialCost, source: 'initial' };
  }
  return { value: '0', source: 'none' };
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

  // Opening-balance entries with a declared EUR cost are pre-dledger acquisitions
  // (Art. 150 VH bis): the user owned the crypto before any tracked event and we trust
  // the costEUR they declared. Line items still post normally for trial-balance
  // correctness, but the cost basis comes from description_data — not inferred from
  // line items, since there's no real fiat side (the EUR was spent years ago).
  if (entry.description_data) {
    try {
      const data = JSON.parse(entry.description_data);
      if (data.type === "opening-balance" && data.costEUR && new Decimal(data.costEUR).gt(0)) {
        const cryptoCurrencies = new Set<string>();
        for (const item of items) {
          const acc = accountMap.get(item.account_id);
          if (!acc || acc.account_type !== "asset") continue;
          if (fiatSet.has(item.currency)) continue;
          if (new Decimal(item.amount).gt(0)) cryptoCurrencies.add(item.currency);
        }
        return {
          type: "acquisition",
          fiatAmountEUR: new Decimal(data.costEUR),
          cryptoCurrencies: [...cryptoCurrencies],
          entry,
        };
      }
    } catch { /* malformed description_data — fall through to line-item classification */ }
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
  skipCurrencies?: Set<string>,
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

      // Skip invalid codes and currencies that can never have rates
      if (!isValidCurrencyCode(bal.currency)) continue;
      if (skipCurrencies?.has(bal.currency)) continue;

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

// ---------- Incremental trial balance ----------

/**
 * Maintains a running balance from journal entries, avoiding repeated DB scans.
 * Accumulates line items incrementally; snapshots produce TrialBalance objects.
 */
class IncrementalBalance {
  private balances = new Map<string, Map<string, Decimal>>();

  addItems(items: LineItem[]): void {
    for (const item of items) {
      let currencies = this.balances.get(item.account_id);
      if (!currencies) {
        currencies = new Map();
        this.balances.set(item.account_id, currencies);
      }
      const current = currencies.get(item.currency) ?? new Decimal(0);
      currencies.set(item.currency, current.plus(new Decimal(item.amount)));
    }
  }

  snapshot(accountMap: Map<string, Account>): TrialBalance {
    const lines: TrialBalanceLine[] = [];
    for (const [accountId, currencies] of this.balances) {
      const account = accountMap.get(accountId);
      if (!account || !account.is_postable) continue;
      const balances: CurrencyBalance[] = [];
      for (const [currency, amount] of currencies) {
        if (!amount.isZero()) {
          balances.push({ currency, amount: amount.toString() });
        }
      }
      if (balances.length === 0) continue;
      balances.sort((a, b) => a.currency.localeCompare(b.currency));
      lines.push({
        account_id: accountId,
        account_name: account.full_name,
        account_type: account.account_type,
        balances,
      });
    }
    return { as_of: "", lines, total_debits: [], total_credits: [] };
  }
}

// ---------- Main algorithm ----------

/** Yield to event loop so UI stays responsive. No-op outside browsers. */
const _hasBrowserLoop = typeof requestAnimationFrame === "function";
const yieldToEventLoop = (): Promise<void> =>
  _hasBrowserLoop ? new Promise(r => requestAnimationFrame(() => r())) : Promise.resolve();

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

  // Build skip set: hidden currencies + rate_source="none" — these can never have rates
  const hiddenCodes = await backend.listHiddenCurrencies();
  const rateSources = await backend.getCurrencyRateOverrides();
  const skipCurrencies = new Set<string>([
    ...hiddenCodes,
    ...rateSources.filter(s => s.rate_source === "none").map(s => s.currency),
  ]);

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

  // 3. Bulk-preload exchange rates into memory for fast in-memory lookup
  const rateCache = new ExchangeRateCache(backend);
  await rateCache.preloadUpTo(yearEnd);

  // 4. Process entries: build running A, collect dispositions/acquisitions
  //    Use incremental trial balance instead of per-disposition DB queries
  const initialPriorCost = opts.priorAcquisitionCost || "0";
  let A = new Decimal(initialPriorCost);
  const skipPreYearA = opts.priorCostSource === 'chained';
  const dispositions: Disposition[] = [];
  const acquisitions: Acquisition[] = [];

  let preYearAcqCount = 0;
  let preYearAcqTotal = new Decimal(0);
  let preYearDispCount = 0;
  let preYearDispTotal = new Decimal(0);
  let skippedDispositionCount = 0;
  const preYearDispSamples: { date: string; description: string; fiatReceived: string; cryptoCurrencies: string[] }[] = [];

  const incrementalBalance = new IncrementalBalance();
  let pendingItems: LineItem[] = [];
  let entryIndex = 0;

  // Same-day cession aggregation. When `groupSameDaySales` is on (default),
  // every disposition on the same calendar date contributes to a single
  // aggregate cession declared on form 2086. V and A are captured at the
  // moment of the FIRST disposition of the day; the formula is applied once
  // to the summed C. Reduces the cession count dramatically for users with
  // many small same-day fills.
  const groupSameDay = opts.groupSameDaySales ?? true;
  /** Maximum |V_candidate − V_first| / V_first tolerated before the smart-grouping
   *  algorithm breaks the bucket. 5% catches notable intraday moves (price swings
   *  or large sales depleting the portfolio) without splitting on benign noise.
   *  Hardcoded for now — exposed as a setting if/when users ask. */
  const SMART_GROUPING_V_DRIFT_THRESHOLD = 0.05;
  interface PendingDayBucket {
    date: string;
    V: Decimal;
    Aatfirst: Decimal;
    cryptoCurrencies: Set<string>;
    totalC: Decimal;
    firstEntry: JournalEntry;
    count: number;
    /** Set to true when an acquisition is processed after this bucket started.
     *  Forces a flush before the next disposition since A has drifted. */
    acquisitionSinceStart: boolean;
  }
  let pendingDay: PendingDayBucket | null = null;

  function flushPendingDay() {
    if (!pendingDay) return;
    const bucket = pendingDay;
    pendingDay = null;
    const cryptoArr = [...bucket.cryptoCurrencies];
    const description = bucket.count === 1
      ? bucket.firstEntry.description
      : `${bucket.count} cessions du ${bucket.date}`;

    if (bucket.date >= yearStart) {
      if (bucket.V.isZero()) {
        skippedDispositionCount++;
        warnings.push(
          bucket.count === 1
            ? `Portfolio value is 0 on ${bucket.date} — cannot compute plus-value for entry "${bucket.firstEntry.description}". You may need to add opening balance entries for your crypto holdings.`
            : `Portfolio value is 0 on ${bucket.date} — cannot compute plus-value for ${bucket.count} grouped cessions. You may need to add opening balance entries for your crypto holdings.`
        );
      } else {
        // Apply formula using A captured at first sale (form-consistent) and aggregate C.
        const costFraction = bucket.Aatfirst.times(bucket.totalC).div(bucket.V);
        const cappedFraction = costFraction.gt(bucket.Aatfirst) ? bucket.Aatfirst : costFraction;
        const plusValue = bucket.totalC.minus(cappedFraction);
        // Running A subtracts the capped cost fraction from CURRENT A (which may
        // include same-day acquisitions that arrived after the first sale).
        const newA = A.minus(cappedFraction);
        const clampedNewA = newA.lt(0) ? new Decimal(0) : newA;

        dispositions.push({
          entryId: bucket.firstEntry.id,
          date: bucket.date,
          description,
          cryptoCurrencies: cryptoArr,
          fiatReceived: bucket.totalC.toFixed(2),
          portfolioValue: bucket.V.toFixed(2),
          acquisitionCostBefore: bucket.Aatfirst.toFixed(2),
          costFraction: cappedFraction.toFixed(2),
          plusValue: plusValue.toFixed(2),
          acquisitionCostAfter: clampedNewA.toFixed(2),
        });
        A = clampedNewA;
      }
    } else {
      preYearDispCount += bucket.count;
      preYearDispTotal = preYearDispTotal.plus(bucket.totalC);
      if (preYearDispSamples.length < 20) {
        preYearDispSamples.push({
          date: bucket.date,
          description,
          fiatReceived: bucket.totalC.toFixed(2),
          cryptoCurrencies: cryptoArr,
        });
      }
      if (!skipPreYearA && !bucket.V.isZero()) {
        const costFraction = bucket.Aatfirst.times(bucket.totalC).div(bucket.V);
        const cappedFraction = costFraction.gt(bucket.Aatfirst) ? bucket.Aatfirst : costFraction;
        const Aafter = A.minus(cappedFraction);
        A = Aafter.lt(0) ? new Decimal(0) : Aafter;
      }
    }
  }

  for (const [entry, items] of allEntries) {
    // Yield periodically for UI responsiveness
    if (++entryIndex % 200 === 0) {
      await yieldToEventLoop();
    }

    // Flush the previous entry's items so the running balance reflects the
    // state immediately BEFORE this entry. V (portfolio value at the moment
    // of cession, Art. 150 VH bis) must include same-day prior entries —
    // e.g. a deposit-then-sell pattern on the same date.
    if (pendingItems.length > 0) {
      incrementalBalance.addItems(pendingItems);
      pendingItems = [];
    }

    // Date rollover: flush any pending day's aggregate cession before starting
    // a new date's processing.
    if (groupSameDay && pendingDay && pendingDay.date !== entry.date) {
      flushPendingDay();
    }

    const event = classifyEntryEvent(entry, items, accountMap, fiatSet);

    if (event.type === "acquisition") {
      // Convert to EUR if not already
      let fiatEUR = event.fiatAmountEUR;
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

      if (!(skipPreYearA && entry.date < yearStart)) {
        A = A.plus(fiatEUR);
      }

      if (entry.date < yearStart) {
        preYearAcqCount++;
        preYearAcqTotal = preYearAcqTotal.plus(fiatEUR);
      }

      if (entry.date >= yearStart) {
        acquisitions.push({
          entryId: entry.id,
          date: entry.date,
          description: entry.description,
          fiatSpent: fiatEUR.toFixed(2),
          cryptoCurrencies: event.cryptoCurrencies,
        });
      }

      // Mark the in-flight bucket dirty so the next same-day disposition triggers
      // a flush — A has shifted, the bucket's A_at_first is no longer accurate.
      if (groupSameDay && pendingDay && pendingDay.date === entry.date) {
        pendingDay.acquisitionSinceStart = true;
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

      // Route through the same-day bucket when grouping is enabled. Smart
      // bucketing: snapshot V *every* same-day sale and break the bucket if
      // either V drifts past SMART_GROUPING_V_DRIFT_THRESHOLD from the bucket's
      // baseline OR an intraday acquisition mutated A. Otherwise just add to C
      // and let the flush (date rollover or end-of-loop) compute the formula.
      if (groupSameDay) {
        // Snapshot V at the moment of this candidate disposition — needed both
        // for the drift check and as the baseline if we start a fresh bucket.
        const tb = incrementalBalance.snapshot(accountMap);
        const { value: V, missingRates, missingCurrencyDates: pvMissing } = await computePortfolioValueEUR(
          tb, fiatSet, rateCache, entry.date, baseCurrency, skipCurrencies,
        );
        for (const mr of missingRates) warnings.push(`Missing rate: ${mr}`);
        missingCurrencyDates.push(...pvMissing);

        const sameDay = pendingDay !== null && pendingDay.date === entry.date;
        let breakBucket = false;
        if (sameDay) {
          if (pendingDay!.acquisitionSinceStart) {
            breakBucket = true;
          } else if (!pendingDay!.V.isZero()) {
            const drift = V.minus(pendingDay!.V).abs().div(pendingDay!.V).toNumber();
            if (drift > SMART_GROUPING_V_DRIFT_THRESHOLD) breakBucket = true;
          }
        }

        if (sameDay && !breakBucket) {
          pendingDay!.totalC = pendingDay!.totalC.plus(C);
          pendingDay!.count++;
          for (const c of event.cryptoCurrencies) pendingDay!.cryptoCurrencies.add(c);
        } else {
          // No bucket, different date, or smart-break triggered — flush the old
          // one (if any) and start a fresh bucket anchored at THIS sale's V/A.
          if (sameDay && breakBucket) flushPendingDay();
          pendingDay = {
            date: entry.date,
            V,
            Aatfirst: A,
            cryptoCurrencies: new Set(event.cryptoCurrencies),
            totalC: C,
            firstEntry: entry,
            count: 1,
            acquisitionSinceStart: false,
          };
        }
        // Accumulate items and skip the inline formula path below.
        pendingItems.push(...items);
        continue;
      }

      // Non-grouped path: snapshot V immediately before this disposition.
      const tb = incrementalBalance.snapshot(accountMap);
      const { value: V, missingRates, missingCurrencyDates: pvMissing } = await computePortfolioValueEUR(
        tb, fiatSet, rateCache, entry.date, baseCurrency, skipCurrencies,
      );
      for (const mr of missingRates) {
        warnings.push(`Missing rate: ${mr}`);
      }
      missingCurrencyDates.push(...pvMissing);

      // Only record dispositions within the tax year
      if (entry.date >= yearStart) {
        if (V.isZero()) {
          skippedDispositionCount++;
          warnings.push(`Portfolio value is 0 on ${entry.date} — cannot compute plus-value for entry "${entry.description}". You may need to add opening balance entries for your crypto holdings.`);
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
        preYearDispCount++;
        preYearDispTotal = preYearDispTotal.plus(C);
        if (preYearDispSamples.length < 20) {
          preYearDispSamples.push({
            date: entry.date,
            description: entry.description,
            fiatReceived: C.toFixed(2),
            cryptoCurrencies: event.cryptoCurrencies,
          });
        }
        if (!skipPreYearA) {
          // Pre-year disposition: only update A when NOT chained
          // (chained priorAcquisitionCost already accounts for prior dispositions)
          if (!V.isZero()) {
            const costFraction = A.times(C).div(V);
            const cappedFraction = costFraction.gt(A) ? A : costFraction;
            const Aafter = A.minus(cappedFraction);
            A = Aafter.lt(0) ? new Decimal(0) : Aafter;
          }
        }
      }
    }

    // Accumulate current entry's items for the next date boundary
    pendingItems.push(...items);
  }

  // Flush the trailing same-day bucket (the last date in the loop never crosses
  // a date boundary so no in-loop flush fires for it).
  if (groupSameDay && pendingDay) {
    flushPendingDay();
  }

  // 5. Compute totals
  let totalPlusValue = new Decimal(0);
  let totalFiatReceived = new Decimal(0);
  for (const d of dispositions) {
    totalPlusValue = totalPlusValue.plus(new Decimal(d.plusValue));
    totalFiatReceived = totalFiatReceived.plus(new Decimal(d.fiatReceived));
  }

  // 6. Compute end-of-year portfolio value (flush remaining items first)
  if (pendingItems.length > 0) {
    incrementalBalance.addItems(pendingItems);
  }
  const yearEndTb = incrementalBalance.snapshot(accountMap);
  const { value: yearEndV, missingRates: yearEndMissing, missingCurrencyDates: yearEndMissingCd } = await computePortfolioValueEUR(
    yearEndTb, fiatSet, rateCache, yearEnd, baseCurrency, skipCurrencies,
  );
  for (const mr of yearEndMissing) {
    warnings.push(`Missing rate for year-end portfolio: ${mr}`);
  }
  missingCurrencyDates.push(...yearEndMissingCd);

  // Collect year-end crypto holdings aggregated by currency
  const holdingsMap = new Map<string, { net: Decimal; accounts: { name: string; amount: string }[] }>();
  for (const line of yearEndTb.lines) {
    if (line.account_type !== "asset") continue;
    for (const bal of line.balances) {
      if (fiatSet.has(bal.currency)) continue;
      const amt = new Decimal(bal.amount);
      if (amt.isZero()) continue;
      let entry = holdingsMap.get(bal.currency);
      if (!entry) {
        entry = { net: new Decimal(0), accounts: [] };
        holdingsMap.set(bal.currency, entry);
      }
      entry.net = entry.net.plus(amt);
      entry.accounts.push({ name: line.account_name, amount: bal.amount });
    }
  }
  const yearEndCryptoHoldings = [...holdingsMap.entries()]
    .filter(([, v]) => !v.net.isZero())
    .map(([currency, v]) => ({
      currency,
      amount: v.net.toString(),
      accounts: v.accounts,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // 6. Deduplicate warnings and missing currency dates
  const uniqueWarnings = [...new Set(warnings)];

  const seenMissing = new Set<string>();
  const uniqueMissingCurrencyDates = missingCurrencyDates.filter(m => {
    const key = `${m.currency}:${m.date}`;
    if (seenMissing.has(key)) return false;
    seenMissing.add(key);
    return true;
  });

  // 7. Build report
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
    priorAcquisitionCost: new Decimal(initialPriorCost).toFixed(2),
    groupSameDaySales: groupSameDay,
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
    warnings: uniqueWarnings,
    skippedDispositionCount,
    missingCurrencyDates: uniqueMissingCurrencyDates,
    entriesProcessed: allEntries.length,
    preYearAcquisitionCount: preYearAcqCount,
    preYearAcquisitionTotal: preYearAcqTotal.toFixed(2),
    preYearDispositionCount: preYearDispCount,
    preYearDispositionTotal: preYearDispTotal.toFixed(2),
    preYearDispositionSamples: preYearDispSamples,
    yearEndCryptoHoldings,
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
