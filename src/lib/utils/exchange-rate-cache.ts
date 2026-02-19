import type { Backend } from "$lib/backend.js";

/** Caches exchange rate lookups for the lifetime of a computation. */
export class ExchangeRateCache {
  private cache = new Map<string, string | null>();
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  async get(from: string, to: string, date: string): Promise<string | null> {
    const key = `${from}:${to}:${date}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const rate = await this.backend.getExchangeRate(from, to, date);
    this.cache.set(key, rate);
    return rate;
  }
}
