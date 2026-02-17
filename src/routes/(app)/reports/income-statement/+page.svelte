<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenTrialLines, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import type { ReportSection } from "$lib/types/index.js";

  const store = new ReportStore();
  const settings = new SettingsStore();
  let fromDate = $state(`${new Date().getFullYear()}-01-01`);
  let toDate = $state(new Date().toISOString().slice(0, 10));

  async function generate() {
    await store.loadIncomeStatement(fromDate, toDate);
  }

  function renderTotals(section: ReportSection): string {
    const totals = filterHiddenBalances(section.totals, settings.hiddenCurrencySet);
    if (totals.length === 0) return formatCurrency(0);
    return totals.map((b) => formatCurrency(Math.abs(parseFloat(b.amount)), b.currency)).join(", ");
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Income Statement</h1>
    <p class="text-muted-foreground">Revenue and expenses for a selected period.</p>
  </div>

  <div class="flex items-end gap-4">
    <div class="space-y-2">
      <label for="from" class="text-sm font-medium">From</label>
      <Input id="from" type="date" bind:value={fromDate} class="w-48" />
    </div>
    <div class="space-y-2">
      <label for="to" class="text-sm font-medium">To</label>
      <Input id="to" type="date" bind:value={toDate} class="w-48" />
    </div>
    <Button onclick={generate} disabled={store.loading}>
      {store.loading ? "Loading..." : "Generate"}
    </Button>
  </div>

  {#if store.loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if store.incomeStatement}
    {@const report = store.incomeStatement}
    {@const hidden = settings.hiddenCurrencySet}
    <Card.Root>
      <Card.Header><Card.Title>Revenue</Card.Title></Card.Header>
      <Table.Root>
        <Table.Body>
          {#each filterHiddenTrialLines(report.revenue.lines, hidden) as line (line.account_id)}
            <Table.Row>
              <Table.Cell><a href="/accounts/{line.account_id}" class="hover:underline">{line.account_name}</a></Table.Cell>
              <Table.Cell class="text-right font-mono">
                {line.balances.map((b) => formatCurrency(Math.abs(parseFloat(b.amount)), b.currency)).join(", ")}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
        <Table.Footer>
          <Table.Row class="font-bold">
            <Table.Cell>Total Revenue</Table.Cell>
            <Table.Cell class="text-right font-mono">{renderTotals(report.revenue)}</Table.Cell>
          </Table.Row>
        </Table.Footer>
      </Table.Root>
    </Card.Root>

    <Card.Root>
      <Card.Header><Card.Title>Expenses</Card.Title></Card.Header>
      <Table.Root>
        <Table.Body>
          {#each filterHiddenTrialLines(report.expenses.lines, hidden) as line (line.account_id)}
            <Table.Row>
              <Table.Cell><a href="/accounts/{line.account_id}" class="hover:underline">{line.account_name}</a></Table.Cell>
              <Table.Cell class="text-right font-mono">
                {line.balances.map((b) => formatCurrency(Math.abs(parseFloat(b.amount)), b.currency)).join(", ")}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
        <Table.Footer>
          <Table.Row class="font-bold">
            <Table.Cell>Total Expenses</Table.Cell>
            <Table.Cell class="text-right font-mono">{renderTotals(report.expenses)}</Table.Cell>
          </Table.Row>
        </Table.Footer>
      </Table.Root>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Description>Net Income</Card.Description>
        <Card.Title class="text-2xl">
          {filterHiddenBalances(report.net_income, hidden).length === 0
            ? formatCurrency(0)
            : filterHiddenBalances(report.net_income, hidden).map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
        </Card.Title>
      </Card.Header>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No data available. Post journal entries to generate the income statement.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
