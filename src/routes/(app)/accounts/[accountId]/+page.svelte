<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import type { Account, CurrencyBalance } from "$lib/types/index.js";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();
  const settings = new SettingsStore();

  const accountId = $derived(page.params.accountId);
  let account = $state<Account | null>(null);
  let balances = $state<CurrencyBalance[]>([]);
  let loading = $state(true);
  const filteredEntries = $derived(filterHiddenEntries(journalStore.entries, settings.hiddenCurrencySet));
  const filteredBalances = $derived(filterHiddenBalances(balances, settings.hiddenCurrencySet));

  onMount(async () => {
    const id = accountId;
    if (!id) { loading = false; return; }
    await accountStore.load();
    account = accountStore.byId.get(id) ?? null;
    if (account) {
      balances = await accountStore.getBalance(id);
      await journalStore.load({ account_id: id });
    }
    loading = false;
  });
</script>

<div class="space-y-6">
  {#if loading}
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  {:else if !account}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Account not found.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <div>
      <h1 class="text-2xl font-bold tracking-tight">{account.full_name}</h1>
      <p class="text-muted-foreground flex items-center gap-2">
        <Badge variant="outline">{account.account_type}</Badge>
        {#if account.is_archived}
          <Badge variant="destructive">Archived</Badge>
        {/if}
      </p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Description>Current Balance</Card.Description>
          <Card.Title class="text-2xl">
            {#if filteredBalances.length === 0}
              {formatCurrency(0)}
            {:else}
              {filteredBalances.map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
            {/if}
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Transactions</Card.Description>
          <Card.Title class="text-2xl">{filteredEntries.length}</Card.Title>
        </Card.Header>
      </Card.Root>
    </div>

    <Card.Root>
      <Card.Header>
        <Card.Title>Transaction History</Card.Title>
      </Card.Header>
      {#if filteredEntries.length === 0}
        <Card.Content>
          <p class="text-sm text-muted-foreground py-8 text-center">
            No transactions for this account yet.
          </p>
        </Card.Content>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Date</Table.Head>
              <Table.Head>Description</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head class="text-right">Amount</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each filteredEntries as [entry, items] (entry.id)}
              {@const relevantItems = items.filter((i) => i.account_id === accountId)}
              <Table.Row>
                <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
                <Table.Cell>
                  <a href="/journal/{entry.id}" class="hover:underline">{entry.description}</a>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={entry.status === "confirmed" ? "default" : "secondary"}>
                    {entry.status}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {#each relevantItems as item}
                    {@const amt = parseFloat(item.amount)}
                    <span class={amt >= 0 ? "" : "text-red-600 dark:text-red-400"}>
                      {formatCurrency(amt, item.currency)}
                    </span>
                  {/each}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Root>
  {/if}
</div>
