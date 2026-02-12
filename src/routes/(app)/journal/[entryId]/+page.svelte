<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { toast } from "svelte-sonner";
  import type { JournalEntry, LineItem } from "$lib/types/index.js";

  const journalStore = new JournalStore();
  const accountStore = new AccountStore();

  const entryId = $derived(page.params.entryId);
  let entry = $state<JournalEntry | null>(null);
  let items = $state<LineItem[]>([]);
  let loading = $state(true);

  async function loadEntry() {
    loading = true;
    const id = entryId;
    if (!id) { loading = false; return; }
    const result = await journalStore.get(id);
    if (result) {
      entry = result.entry;
      items = result.items;
    }
    loading = false;
  }

  async function handleVoid() {
    if (!entry) return;
    const reversal = await journalStore.void_(entry.id);
    if (reversal) {
      toast.success("Entry voided");
      await loadEntry();
    } else {
      toast.error(journalStore.error ?? "Failed to void entry");
    }
  }

  function accountName(id: string): string {
    return accountStore.byId.get(id)?.full_name ?? id;
  }

  onMount(async () => {
    await accountStore.load();
    await loadEntry();
  });
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Journal Entry</h1>
      {#if entry}
        <p class="text-muted-foreground">{entry.description}</p>
      {/if}
    </div>
    {#if entry && entry.status === "confirmed"}
      <Button variant="destructive" onclick={handleVoid}>Void Entry</Button>
    {/if}
  </div>

  {#if loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if !entry}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Entry not found.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Details</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt class="text-muted-foreground">Date</dt>
            <dd class="font-medium">{entry.date}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Status</dt>
            <dd>
              <Badge variant={entry.status === "confirmed" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                {entry.status}
              </Badge>
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Source</dt>
            <dd class="font-medium">{entry.source}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Created</dt>
            <dd class="font-medium">{entry.created_at}</dd>
          </div>
        </dl>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Line Items</Card.Title>
      </Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Account</Table.Head>
            <Table.Head>Currency</Table.Head>
            <Table.Head class="text-right">Debit</Table.Head>
            <Table.Head class="text-right">Credit</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each items as item (item.id)}
            {@const amount = parseFloat(item.amount)}
            <Table.Row>
              <Table.Cell>
                <a href="/accounts/{item.account_id}" class="hover:underline">
                  {accountName(item.account_id)}
                </a>
              </Table.Cell>
              <Table.Cell>{item.currency}</Table.Cell>
              <Table.Cell class="text-right font-mono">
                {amount > 0 ? formatCurrency(amount, item.currency) : ""}
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {amount < 0 ? formatCurrency(Math.abs(amount), item.currency) : ""}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {/if}
</div>
