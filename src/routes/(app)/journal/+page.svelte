<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { convertBalances } from "$lib/utils/currency-convert.js";
  import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
  import type { CurrencyBalance } from "$lib/types/index.js";
  import { filterHiddenEntries } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { formatExtension, formatLabel, type LedgerFormat } from "$lib/ledger-format.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import type { TransactionFilter } from "$lib/types/index.js";

  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import Pagination from "$lib/components/Pagination.svelte";

  const store = new JournalStore();
  const settings = new SettingsStore();
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const filteredEntries = $derived(filterHiddenEntries(store.entries, hidden));
  let exporting = $state(false);
  let exportFormat = $state<LedgerFormat>("ledger");
  let searchTerm = $state("");
  let showDuplicates = $state(false);

  type JournalSortKey = "date" | "description" | "status" | "amount";
  const sort = createSortState<JournalSortKey>();

  interface DuplicateGroup {
    confidence: "likely" | "possible";
    entries: typeof filteredEntries;
  }

  const duplicateGroups = $derived.by((): DuplicateGroup[] => {
    const groups: DuplicateGroup[] = [];
    const entries = filteredEntries;
    const checked = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (checked.has(entries[i][0].id)) continue;
      const [entryA, itemsA] = entries[i];
      const amountsA = itemsA.map((it) => `${it.amount}:${it.currency}`).sort().join(",");
      const group: typeof filteredEntries = [];

      for (let j = i + 1; j < entries.length; j++) {
        if (checked.has(entries[j][0].id)) continue;
        const [entryB, itemsB] = entries[j];
        if (entryA.date !== entryB.date) continue;

        const amountsB = itemsB.map((it) => `${it.amount}:${it.currency}`).sort().join(",");
        if (amountsA !== amountsB) continue;

        // Same date + same amounts
        const isLikely = entryA.description === entryB.description;
        if (group.length === 0) {
          group.push(entries[i]);
        }
        group.push(entries[j]);
        checked.add(entries[j][0].id);
      }

      if (group.length > 0) {
        checked.add(entryA.id);
        const isLikely = group.every(([e]) => e.description === group[0][0].description);
        groups.push({
          confidence: isLikely ? "likely" : "possible",
          entries: group,
        });
      }
    }

    return groups;
  });

  // Debounced backend search
  let debounceTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const term = searchTerm.trim();
    const orderBy = sort.key !== "amount" ? sort.key : null;
    const orderDir = sort.direction;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const filter: TransactionFilter = {};
      if (term) filter.description_search = term;
      if (orderBy && orderDir) {
        filter.order_by = orderBy;
        filter.order_direction = orderDir;
      }
      store.load(filter);
    }, 300);
    return () => clearTimeout(debounceTimer);
  });

  function totalDebits(items: { amount: string }[]): number {
    return items.reduce((sum, i) => {
      const n = parseFloat(i.amount);
      return n > 0 ? sum + n : sum;
    }, 0);
  }

  function debitsByCurrency(items: { amount: string; currency: string }[]): CurrencyBalance[] {
    const map = new Map<string, number>();
    for (const item of items) {
      const n = parseFloat(item.amount);
      if (n > 0) map.set(item.currency, (map.get(item.currency) ?? 0) + n);
    }
    return [...map].map(([currency, amount]) => ({ currency, amount: String(amount) }));
  }

  function formatDebitTotal(items: { amount: string; currency: string }[]): string {
    const byCode = debitsByCurrency(items);
    if (byCode.length === 0) return formatCurrency(0, settings.currency);
    return byCode.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
  }

  let convertedTotals = $state(new Map<string, string>());
  let conversionGen = 0;

  $effect(() => {
    const entries = filteredEntries;
    const baseCurrency = settings.currency;
    if (!baseCurrency || entries.length === 0) {
      convertedTotals = new Map();
      return;
    }

    const gen = ++conversionGen;
    const cache = new ExchangeRateCache(getBackend());
    const results = new Map<string, string>();

    // Sync pass: entries where all debits are already in base currency
    const asyncEntries: [string, CurrencyBalance[], string][] = [];
    for (const [entry, items] of entries) {
      const debits = debitsByCurrency(items);
      if (debits.length === 0) {
        results.set(entry.id, formatCurrency(0, baseCurrency));
      } else if (debits.every((b) => b.currency === baseCurrency)) {
        const total = debits.reduce((s, b) => s + parseFloat(b.amount), 0);
        results.set(entry.id, formatCurrency(total, baseCurrency));
      } else {
        asyncEntries.push([entry.id, debits, entry.date]);
      }
    }
    convertedTotals = new Map(results);

    // Async pass: entries with foreign currencies
    if (asyncEntries.length > 0) {
      (async () => {
        for (const [id, debits, date] of asyncEntries) {
          if (gen !== conversionGen) return;
          const summary = await convertBalances(debits, baseCurrency, date, cache);
          if (gen !== conversionGen) return;

          let formatted: string;
          if (summary.unconverted.length === 0) {
            formatted = formatCurrency(summary.total, baseCurrency);
          } else {
            const parts: string[] = [];
            if (summary.total !== 0) parts.push(formatCurrency(summary.total, baseCurrency));
            for (const u of summary.unconverted) {
              parts.push(formatCurrency(u.amount, u.currency));
            }
            formatted = parts.join(" + ");
          }
          results.set(id, formatted);
          convertedTotals = new Map(results);
        }
      })();
    }
  });

  async function handleExport() {
    exporting = true;
    try {
      const content = await getBackend().exportLedgerFile(exportFormat);
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dledger-export${formatExtension(exportFormat)}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Ledger file exported");
    } catch (err) {
      toast.error(String(err));
    } finally {
      exporting = false;
    }
  }
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="shrink-0">
      <h1 class="text-2xl font-bold tracking-tight">Journal</h1>
      <p class="text-muted-foreground hidden sm:block">View and manage all journal entries.</p>
    </div>
    <ListFilter bind:value={searchTerm} placeholder="Filter entries..." class="order-last sm:order-none" />
    <div class="flex flex-wrap gap-2 shrink-0">
      <Button variant="outline" size="sm" class="hidden sm:inline-flex" onclick={async () => { await store.loadAll(); showDuplicates = true; }}>
        Detect Duplicates
      </Button>
      <select
        class="h-8 rounded-md border border-input bg-background px-2 text-xs"
        bind:value={exportFormat}
      >
        <option value="ledger">Ledger (.ledger)</option>
        <option value="beancount">Beancount (.beancount)</option>
        <option value="hledger">hledger (.journal)</option>
      </select>
      <Button variant="outline" size="sm" onclick={handleExport} disabled={exporting}>
        {exporting ? "Exporting..." : "Export"}
      </Button>
      <Button variant="outline" size="sm" href="/sources">Import CSV</Button>
      <Button variant="outline" size="sm" href="/sources">Import</Button>
      <Button size="sm" href="/journal/new">New Entry</Button>
    </div>
  </div>

  {#if store.loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3, 4, 5] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if filteredEntries.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No journal entries yet. Create your first entry to start recording transactions.
        </p>
      </Card.Content>
    </Card.Root>
  {:else if filteredEntries.length === 0 && searchTerm}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No entries match "{searchTerm}".
        </p>
        <div class="flex justify-center mt-2">
          <Button variant="outline" size="sm" onclick={() => (searchTerm = "")}>Clear search</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={sort.key === "date"} direction={sort.direction} onclick={() => sort.toggle("date")}>Date</SortableHeader>
            <SortableHeader active={sort.key === "description"} direction={sort.direction} onclick={() => sort.toggle("description")}>Description</SortableHeader>
            <SortableHeader active={sort.key === "status"} direction={sort.direction} onclick={() => sort.toggle("status")} class="hidden md:table-cell">Status</SortableHeader>
            <SortableHeader active={sort.key === "amount"} direction={sort.direction} onclick={() => sort.toggle("amount")} class="text-right">Amount</SortableHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const sortedEntries = sort.key === "amount" && sort.direction ? sortItems(filteredEntries, ([, items]: [any, any]) => totalDebits(items), sort.direction) : filteredEntries}
          {#each sortedEntries as [entry, items] (entry.id)}
            <Table.Row>
              <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
              <Table.Cell class="max-w-[300px]">
                <a href="/journal/{entry.id}" class="font-medium hover:underline truncate block" title={entry.description}>{entry.description}</a>
              </Table.Cell>
              <Table.Cell class="hidden md:table-cell">
                <Badge variant={entry.status === "confirmed" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                  {entry.status}
                </Badge>
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {convertedTotals.get(entry.id) ?? formatDebitTotal(items)}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>

    <div class="flex items-center justify-between">
      <span class="text-sm text-muted-foreground">
        {store.totalCount} total {store.totalCount === 1 ? "entry" : "entries"}
      </span>
      <Pagination
        currentPage={store.currentPage}
        totalPages={store.totalPages}
        onPageChange={(page) => store.loadPage(page)}
      />
    </div>
  {/if}
</div>

<!-- Duplicate Detection Dialog -->
<Dialog.Root bind:open={showDuplicates}>
  <Dialog.Content class="max-w-2xl max-h-[80vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Duplicate Detection</Dialog.Title>
      <Dialog.Description>
        Entries with the same date and amounts that may be duplicates.
      </Dialog.Description>
    </Dialog.Header>
    {#if duplicateGroups.length === 0}
      <p class="text-sm text-muted-foreground py-8 text-center">
        No potential duplicates found.
      </p>
    {:else}
      <div class="space-y-4">
        {#each duplicateGroups as group, gi}
          <div class="rounded-md border p-3 space-y-2">
            <div class="flex items-center gap-2">
              <Badge variant={group.confidence === "likely" ? "destructive" : "secondary"}>
                {group.confidence === "likely" ? "Likely duplicate" : "Possible duplicate"}
              </Badge>
              <span class="text-xs text-muted-foreground">{group.entries.length} entries</span>
            </div>
            {#each group.entries as [entry, items]}
              <div class="flex items-center justify-between text-sm rounded px-2 py-1.5 bg-muted/30">
                <div class="flex items-center gap-3">
                  <span class="text-muted-foreground w-24">{entry.date}</span>
                  <a href="/journal/{entry.id}" class="hover:underline">{entry.description}</a>
                </div>
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs">{convertedTotals.get(entry.id) ?? formatDebitTotal(items)}</span>
                  <Badge variant="outline" class="text-xs">{entry.status}</Badge>
                  {#if entry.status !== "voided"}
                    <Button variant="ghost" size="sm" class="h-6 text-xs text-destructive hover:text-destructive"
                      onclick={async () => {
                        try {
                          await getBackend().voidJournalEntry(entry.id);
                          await store.load();
                          toast.success("Entry voided");
                        } catch (e) {
                          toast.error(String(e));
                        }
                      }}>Void</Button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
