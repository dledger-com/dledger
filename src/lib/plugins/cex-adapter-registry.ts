import type { CexAdapter, ExchangeId } from "../cex/types.js";

export class CexAdapterRegistry {
  private adapters = new Map<string, CexAdapter>();

  register(adapter: CexAdapter): void {
    this.adapters.set(adapter.exchangeId, adapter);
  }

  get(id: ExchangeId): CexAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown exchange: ${id}`);
    return adapter;
  }

  getAll(): CexAdapter[] {
    return [...this.adapters.values()];
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}
