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
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import * as m from "$paraglide/messages.js";

  const store = new ReportStore();
  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let searchTerm = $state("");
  type TrialBalanceSortKey = "account" | "type" | "debit" | "credit";
  const sort = createSortState<TrialBalanceSortKey>();
  const trialBalanceAccessors: Record<TrialBalanceSortKey, (line: typeof store.trialBalance extends { lines: (infer L)[] } | null ? L : never) => string | number> = {
    account: (l) => l.account_name,
    type: (l) => l.account_type,
    debit: (l) => l.balances.filter((b) => parseFloat(b.amount) > 0).reduce((s, b) => s + parseFloat(b.amount), 0),
    credit: (l) => l.balances.filter((b) => parseFloat(b.amount) < 0).reduce((s, b) => s + Math.abs(parseFloat(b.amount)), 0),
  };

  async function generate() {
    await store.enqueueTrialBalance(asOf);
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">{m.report_as_of_date()}</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={store.loading}>
      {store.loading ? m.state_loading_report() : m.btn_generate()}
    </Button>
    {#if store.trialBalance}
      <Button variant="outline" onclick={() => exportTrialBalanceCsv(store.trialBalance!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
    {/if}
    <ListFilter bind:value={searchTerm} placeholder={m.placeholder_filter_accounts()} />
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
            <SortableHeader active={sort.key === "account"} direction={sort.direction} onclick={() => sort.toggle("account")}>{m.label_account()}</SortableHeader>
            <SortableHeader active={sort.key === "type"} direction={sort.direction} onclick={() => sort.toggle("type")}>{m.label_type()}</SortableHeader>
            <SortableHeader active={sort.key === "debit"} direction={sort.direction} onclick={() => sort.toggle("debit")} class="text-right">{m.label_debit()}</SortableHeader>
            <SortableHeader active={sort.key === "credit"} direction={sort.direction} onclick={() => sort.toggle("credit")} class="text-right">{m.label_credit()}</SortableHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const sortedLines = sort.key && sort.direction ? sortItems(filteredLines, trialBalanceAccessors[sort.key], sort.direction) : filteredLines}
          {#each sortedLines as line (line.account_id)}
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
            <Table.Cell colspan={2}>{m.report_totals()}</Table.Cell>
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
          {m.empty_no_trial_balance_data()}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
