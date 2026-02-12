import type { JournalEntry, LineItem, TransactionFilter } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

export class JournalStore {
  entries = $state<[JournalEntry, LineItem[]][]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  readonly headers = $derived(this.entries.map(([e]) => e));

  readonly confirmed = $derived(
    this.entries.filter(([e]) => e.status === "confirmed"),
  );

  readonly byId = $derived(
    new Map(this.entries.map(([e, items]) => [e.id, { entry: e, items }])),
  );

  async load(filter: TransactionFilter = {}) {
    this.loading = true;
    this.error = null;
    try {
      this.entries = await getBackend().queryJournalEntries(filter);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async post(entry: JournalEntry, items: LineItem[]): Promise<boolean> {
    try {
      await getBackend().postJournalEntry(entry, items);
      await this.load();
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async void_(id: string): Promise<JournalEntry | null> {
    try {
      const reversal = await getBackend().voidJournalEntry(id);
      await this.load();
      return reversal;
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
