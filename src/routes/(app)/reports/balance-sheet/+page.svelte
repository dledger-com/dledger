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
  let asOf = $state(new Date().toISOString().slice(0, 10));

  async function generate() {
    await store.loadBalanceSheet(asOf);
  }

  function renderTotals(section: ReportSection): string {
    const totals = filterHiddenBalances(section.totals, settings.hiddenCurrencySet);
    if (totals.length === 0) return formatCurrency(0);
    return totals.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Balance Sheet</h1>
    <p class="text-muted-foreground">Assets, liabilities, and equity at a given date.</p>
  </div>

  <div class="flex items-end gap-4">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">As of Date</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-48" />
    </div>
    <Button onclick={generate} disabled={store.loading}>
      {store.loading ? "Loading..." : "Generate"}
    </Button>
  </div>

  {#if store.loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if store.balanceSheet}
    {@const report = store.balanceSheet}
    {#each [report.assets, report.liabilities, report.equity] as section (section.title)}
      {@const filteredLines = filterHiddenTrialLines(section.lines, settings.hiddenCurrencySet)}
      <Card.Root>
        <Card.Header><Card.Title>{section.title}</Card.Title></Card.Header>
        {#if filteredLines.length === 0}
          <Card.Content>
            <p class="text-sm text-muted-foreground py-4 text-center">No accounts with balances.</p>
          </Card.Content>
        {:else}
          <Table.Root>
            <Table.Body>
              {#each filteredLines as line (line.account_id)}
                <Table.Row>
                  <Table.Cell><a href="/accounts/{line.account_id}" class="hover:underline">{line.account_name}</a></Table.Cell>
                  <Table.Cell class="text-right font-mono">
                    {line.balances.map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
            <Table.Footer>
              <Table.Row class="font-bold">
                <Table.Cell>Total {section.title}</Table.Cell>
                <Table.Cell class="text-right font-mono">{renderTotals(section)}</Table.Cell>
              </Table.Row>
            </Table.Footer>
          </Table.Root>
        {/if}
      </Card.Root>
    {/each}
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No data available. Post journal entries to generate the balance sheet.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
