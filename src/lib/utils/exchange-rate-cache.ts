import Decimal from "decimal.js-light";
import type { Backend } from "$lib/backend.js";

/** Sorted array of {date, rate} for a currency pair, date ascending. */
interface RateEntry {
  date: string;
  rate: string;
}

/** Caches exchange rate lookups for the lifetime of a computation. */
export class ExchangeRateCache {
  private cache = new Map<string, string | null>();
  private backend: Backend;

  /**
   * Preloaded rate data: "from:to" → RateEntry[] sorted by date ascending.
   * Used for fast binary-search lookups without per-call SQL.
   */
  private preloaded = new Map<string, RateEntry[]>();

  constructor(backend: Backend) {
    this.backend = backend;
  }

  /**
   * Bulk-load all exchange rates up to maxDate into memory for fast lookup.
   * After calling this, get() will resolve most lookups from memory via
   * binary search (direct → inverse), only falling back to DB for transitive.
   */
  async preloadUpTo(maxDate: string): Promise<void> {
    const rates = await this.backend.listExchangeRates();
    for (const r of rates) {
      if (r.date > maxDate) continue;
      const key = `${r.from_currency}:${r.to_currency}`;
      let entries = this.preloaded.get(key);
      if (!entries) {
        entries = [];
        this.preloaded.set(key, entries);
      }
      entries.push({ date: r.date, rate: r.rate });
    }
    // Sort each pair's entries by date ascending for binary search
    for (const entries of this.preloaded.values()) {
      entries.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  async get(from: string, to: string, date: string): Promise<string | null> {
    const key = `${from}:${to}:${date}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    // Try preloaded data first (direct → inverse)
    if (this.preloaded.size > 0) {
      const rate = this.lookupPreloaded(from, to, date);
      if (rate !== undefined) {
        this.cache.set(key, rate);
        return rate;
      }
      // If preloaded data exists but no match, still try DB for transitive
    }

    const rate = await this.backend.getExchangeRate(from, to, date);
    this.cache.set(key, rate);
    return rate;
  }

  /**
   * Look up rate from preloaded data using "on or before" binary search.
   * Returns the rate string, null if no rate found, or undefined if
   * no preloaded data exists for this pair (caller should fall back to DB).
   */
  private lookupPreloaded(from: string, to: string, date: string): string | null | undefined {
    // Direct: from→to
    const directKey = `${from}:${to}`;
    const directEntries = this.preloaded.get(directKey);
    if (directEntries) {
      const entry = binarySearchOnOrBefore(directEntries, date);
      if (entry) return entry.rate;
    }

    // Inverse: to→from, invert rate
    const inverseKey = `${to}:${from}`;
    const inverseEntries = this.preloaded.get(inverseKey);
    if (inverseEntries) {
      const entry = binarySearchOnOrBefore(inverseEntries, date);
      if (entry) {
        const d = new Decimal(entry.rate);
        if (!d.isZero()) {
          return new Decimal(1).div(d).toString();
        }
      }
    }

    // If we had preloaded data for at least one direction, return null (no rate found)
    // If neither direction had data, return undefined (unknown — fall back to DB for transitive)
    if (directEntries || inverseEntries) return null;
    return undefined;
  }
}

/**
 * Binary search for the latest entry with date <= target.
 * Entries must be sorted by date ascending.
 */
function binarySearchOnOrBefore(entries: RateEntry[], target: string): RateEntry | null {
  let lo = 0;
  let hi = entries.length - 1;
  let result: RateEntry | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].date <= target) {
      result = entries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}
