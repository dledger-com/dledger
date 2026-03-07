import type { JournalEntry, LineItem, TransactionFilter } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";
import { invalidate } from "$lib/data/invalidation.js";

export class JournalStore {
  entries = $state<JournalEntry[]>([]);
  lineItemCache = $state(new Map<string, LineItem[]>());
  loading = $state(false);
  error = $state<string | null>(null);
  totalCount = $state(0);
  private currentFilter = $state<TransactionFilter>({});
  private _loadingLineItems = $state(false);

  get loadingLineItems() {
    return this._loadingLineItems;
  }

  /** Entries paired with their line items (from cache). */
  readonly withItems = $derived<[JournalEntry, LineItem[]][]>(
    this.entries.map(e => [e, this.lineItemCache.get(e.id) ?? []])
  );

  readonly headers = $derived(this.entries);

  readonly confirmed = $derived(
    this.entries.filter(e => e.status === "confirmed"),
  );

  readonly byId = $derived(
    new Map(this.entries.map(e => [e.id, { entry: e, items: this.lineItemCache.get(e.id) ?? [] }])),
  );

  async load(filter: TransactionFilter = {}) {
    this.loading = true;
    this.error = null;
    this.currentFilter = filter;
    // Yield so Svelte can render the skeleton before the query blocks
    await new Promise(r => requestAnimationFrame(r));
    try {
      const backend = getBackend();
      const queryFilter = { ...filter };
      delete queryFilter.limit;
      delete queryFilter.offset;

      if (backend.queryJournalEntriesOnly) {
        this.entries = await backend.queryJournalEntriesOnly(queryFilter);
      } else {
        const pairs = await backend.queryJournalEntries(queryFilter);
        this.entries = pairs.map(([e]) => e);
        // Pre-populate cache from full results
        const cache = new Map<string, LineItem[]>();
        for (const [e, items] of pairs) cache.set(e.id, items);
        this.lineItemCache = cache;
      }
      this.totalCount = this.entries.length;
      this.lineItemCache = new Map();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadAll() {
    return this.load(this.currentFilter);
  }

  /** Load line items for a batch of entry IDs (viewport-driven). */
  async loadLineItems(entryIds: string[]): Promise<void> {
    const needed = entryIds.filter(id => !this.lineItemCache.has(id));
    if (needed.length === 0) return;
    this._loadingLineItems = true;
    try {
      const backend = getBackend();
      let items: Map<string, LineItem[]>;
      if (backend.getLineItemsForEntries) {
        items = await backend.getLineItemsForEntries(needed);
      } else {
        // Fallback: use queryJournalEntries per entry
        items = new Map();
        for (const id of needed) {
          const result = await backend.getJournalEntry(id);
          if (result) items.set(id, result[1]);
        }
      }
      const updated = new Map(this.lineItemCache);
      for (const [id, li] of items) updated.set(id, li);
      this.lineItemCache = updated;
    } finally {
      this._loadingLineItems = false;
    }
  }

  /** Load ALL line items (for operations that need the full dataset). */
  async loadAllLineItems(): Promise<void> {
    const needed = this.entries.filter(e => !this.lineItemCache.has(e.id)).map(e => e.id);
    if (needed.length === 0) return;
    await this.loadLineItems(needed);
  }

  async post(entry: JournalEntry, items: LineItem[]): Promise<boolean> {
    try {
      await getBackend().postJournalEntry(entry, items);
      await this.load(this.currentFilter);
      invalidate("journal", "reports");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async void_(id: string): Promise<JournalEntry | null> {
    try {
      const reversal = await getBackend().voidJournalEntry(id);
      await this.load(this.currentFilter);
      invalidate("journal", "reports");
      return reversal;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async edit(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string } | null> {
    try {
      const result = await getBackend().editJournalEntry(originalId, newEntry, newItems, newMetadata, newLinks);
      await this.load(this.currentFilter);
      invalidate("journal", "accounts", "reports");
      return result;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async get(id: string): Promise<{ entry: JournalEntry; items: LineItem[] } | null> {
    try {
      const result = await getBackend().getJournalEntry(id);
      if (!result) return null;
      return { entry: result[0], items: result[1] };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}
