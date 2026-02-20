import type { JournalEntry, LineItem, TransactionFilter } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

const DEFAULT_PAGE_SIZE = 50;

export class JournalStore {
  entries = $state<[JournalEntry, LineItem[]][]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  // Pagination state
  totalCount = $state(0);
  pageSize = $state(DEFAULT_PAGE_SIZE);
  currentPage = $state(1);
  private currentFilter = $state<TransactionFilter>({});

  readonly totalPages = $derived(Math.max(1, Math.ceil(this.totalCount / this.pageSize)));
  readonly hasNextPage = $derived(this.currentPage < this.totalPages);
  readonly hasPrevPage = $derived(this.currentPage > 1);

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
    this.currentFilter = filter;
    this.currentPage = 1;
    try {
      const backend = getBackend();
      // Get total count (without limit/offset)
      const countFilter = { ...filter };
      delete countFilter.limit;
      delete countFilter.offset;
      this.totalCount = await backend.countJournalEntries(countFilter);

      // If explicit limit was passed, use it directly (non-paginated mode)
      if (filter.limit !== undefined) {
        this.entries = await backend.queryJournalEntries(filter);
        return;
      }

      // Paginated load
      this.entries = await backend.queryJournalEntries({
        ...filter,
        limit: this.pageSize,
        offset: 0,
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.loading = true;
    this.error = null;
    this.currentPage = page;
    try {
      this.entries = await getBackend().queryJournalEntries({
        ...this.currentFilter,
        limit: this.pageSize,
        offset: (page - 1) * this.pageSize,
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async loadAll() {
    this.loading = true;
    this.error = null;
    try {
      this.entries = await getBackend().queryJournalEntries(this.currentFilter);
      this.totalCount = this.entries.length;
      this.currentPage = 1;
      this.pageSize = this.entries.length || DEFAULT_PAGE_SIZE;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async post(entry: JournalEntry, items: LineItem[]): Promise<boolean> {
    try {
      await getBackend().postJournalEntry(entry, items);
      await this.load(this.currentFilter);
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
