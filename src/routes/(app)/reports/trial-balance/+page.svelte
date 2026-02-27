<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenTrialLines, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { exportTrialBalanceCsv } from "$lib/utils/csv-export.js";
  import Download from "lucide-svelte/icons/download";
  import ListFilter from "$lib/components/ListFilter.svelte";

  const store = new ReportStore();
  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let searchTerm = $state("");

  async function generate() {
    await store.loadTrialBalance(asOf);
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Trial Balance</h1>
    <p class="text-muted-foreground">All account balances verifying that total debits equal total credits.</p>
  </div>

  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">As of Date</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={store.loading}>
      {store.loading ? "Loading..." : "Generate"}
    </Button>
    {#if store.trialBalance}
      <Button variant="outline" onclick={() => exportTrialBalanceCsv(store.trialBalance!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
    {/if}
    <ListFilter bind:value={searchTerm} placeholder="Filter accounts..." />
  </div>

  {#if store.loading}
    <Card.Root>
      <Card.Content class="py-4">
        {#each [1, 2, 3, 4] as _}
          <Skeleton class="h-10 w-full mb-2" />
        {/each}
      </Card.Content>
    </Card.Root>
  {:else if store.error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{store.error}</p>
      </Card.Content>
    </Card.Root>
  {:else if store.trialBalance && store.trialBalance.lines.length > 0}
    {@const hidden = settings.showHidden ? new Set<string>() : getHiddenCurrencySet()}
    {@const hiddenFilteredLines = filterHiddenTrialLines(store.trialBalance.lines, hidden)}
    {@const term = searchTerm.trim().toLowerCase()}
    {@const filteredLines = term ? hiddenFilteredLines.filter((l) => l.account_name.toLowerCase().includes(term) || l.account_type.toLowerCase().includes(term)) : hiddenFilteredLines}
    {@const filteredDebits = filterHiddenBalances(store.trialBalance.total_debits, hidden)}
    {@const filteredCredits = filterHiddenBalances(store.trialBalance.total_credits, hidden)}
    <Card.Root>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Account</Table.Head>
            <Table.Head>Type</Table.Head>
            <Table.Head class="text-right">Debit</Table.Head>
            <Table.Head class="text-right">Credit</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each filteredLines as line (line.account_id)}
            <Table.Row>
              <Table.Cell>
                <a href="/accounts/{line.account_id}" class="hover:underline">{line.account_name}</a>
              </Table.Cell>
              <Table.Cell><AccountTypeBadge type={line.account_type} /></Table.Cell>
              <Table.Cell class="text-right font-mono">
                {#each line.balances.filter(b => parseFloat(b.amount) > 0) as b}
                  {formatCurrency(b.amount, b.currency)}
                {/each}
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {#each line.balances.filter(b => parseFloat(b.amount) < 0) as b}
                  {formatCurrency(Math.abs(parseFloat(b.amount)), b.currency)}
                {/each}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
        <Table.Footer>
          <Table.Row class="font-bold">
            <Table.Cell colspan={2}>Totals</Table.Cell>
            <Table.Cell class="text-right font-mono">
              {#each filteredDebits as b}
                {formatCurrency(b.amount, b.currency)}
              {/each}
            </Table.Cell>
            <Table.Cell class="text-right font-mono">
              {#each filteredCredits as b}
                {formatCurrency(b.amount, b.currency)}
              {/each}
            </Table.Cell>
          </Table.Row>
        </Table.Footer>
      </Table.Root>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No data available. Post journal entries to see the trial balance.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
