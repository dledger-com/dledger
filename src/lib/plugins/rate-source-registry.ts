import type { RateSourceExtension } from "./types.js";

export class RateSourceRegistry {
  private sources: RateSourceExtension[] = [];

  register(source: RateSourceExtension): void {
    this.sources.push(source);
    // Keep sorted by priority (highest first)
    this.sources.sort((a, b) => b.priority - a.priority);
  }

  getAll(): RateSourceExtension[] {
    return [...this.sources];
  }

  getById(id: string): RateSourceExtension | undefined {
    return this.sources.find((s) => s.sourceId === id);
  }

  /**
   * Find the best source that can handle this currency, respecting priority order.
   */
  findBest(
    currency: string,
    assetType: string,
    baseCurrency: string,
  ): RateSourceExtension | null {
    for (const source of this.sources) {
      if (source.canHandle(currency, assetType, baseCurrency)) {
        return source;
      }
    }
    return null;
  }
}
