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
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";

  const store = new JournalStore();
  const settings = new SettingsStore();
  const filteredEntries = $derived(filterHiddenEntries(store.entries, settings.hiddenCurrencySet));
  let exporting = $state(false);

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
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Journal</h1>
      <p class="text-muted-foreground">View and manage all journal entries.</p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" onclick={handleExport} disabled={exporting}>
        {exporting ? "Exporting..." : "Export"}
      </Button>
      <Button variant="outline" href="/journal/import">Import</Button>
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
          {#each filteredEntries as [entry, items] (entry.id)}
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
