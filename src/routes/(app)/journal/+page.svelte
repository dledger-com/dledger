<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import Search from "lucide-svelte/icons/search";
  import X from "lucide-svelte/icons/x";

  import * as Dialog from "$lib/components/ui/dialog/index.js";

  const store = new JournalStore();
  const settings = new SettingsStore();
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const filteredEntries = $derived(filterHiddenEntries(store.entries, hidden));
  let exporting = $state(false);
  let searchTerm = $state("");
  let showDuplicates = $state(false);

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

  const searchedEntries = $derived.by(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return filteredEntries;
    return filteredEntries.filter(
      ([entry]) =>
        entry.description.toLowerCase().includes(term) ||
        entry.date.includes(term) ||
        entry.status.toLowerCase().includes(term),
    );
  });

  function totalDebits(items: { amount: string }[]): number {
    return items.reduce((sum, i) => {
      const n = parseFloat(i.amount);
      return n > 0 ? sum + n : sum;
    }, 0);
  }

  async function handleExport() {
    exporting = true;
    try {
      const content = await getBackend().exportLedgerFile();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "dledger-export.ledger";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Ledger file exported");
    } catch (err) {
      toast.error(String(err));
    } finally {
      exporting = false;
    }
  }

  onMount(() => store.load());
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div class="shrink-0">
      <h1 class="text-2xl font-bold tracking-tight">Journal</h1>
      <p class="text-muted-foreground">View and manage all journal entries.</p>
    </div>
    <div class="relative w-full max-w-sm">
      <Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input type="text" placeholder="Filter entries..." bind:value={searchTerm} class="pl-9 pr-9"
        onkeydown={(e) => { if (e.key === 'Escape') searchTerm = ''; }} />
      {#if searchTerm}
        <button type="button" onclick={() => (searchTerm = "")}
          class="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
          <X class="size-4" />
        </button>
      {/if}
    </div>
    <div class="flex gap-2 shrink-0">
      <Button variant="outline" size="sm" onclick={() => { showDuplicates = true; }}>
        Detect Duplicates
      </Button>
      <Button variant="outline" onclick={handleExport} disabled={exporting}>
        {exporting ? "Exporting..." : "Export"}
      </Button>
      <Button variant="outline" href="/sources">Import</Button>
      <Button href="/journal/new">New Entry</Button>
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
  {:else if searchedEntries.length === 0}
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
            <Table.Head>Date</Table.Head>
            <Table.Head>Description</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head class="text-right">Debit Total</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each searchedEntries as [entry, items] (entry.id)}
            <Table.Row>
              <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
              <Table.Cell>
                <a href="/journal/{entry.id}" class="font-medium hover:underline">{entry.description}</a>
              </Table.Cell>
              <Table.Cell>
                <Badge variant={entry.status === "confirmed" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                  {entry.status}
                </Badge>
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {formatCurrency(totalDebits(items))}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
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
                  <span class="font-mono text-xs">{formatCurrency(totalDebits(items))}</span>
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
