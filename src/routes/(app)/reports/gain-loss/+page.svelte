<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenGainLoss } from "$lib/utils/currency-filter.js";
  import { getSpamCurrencySet } from "$lib/data/spam-currencies.svelte.js";

  const reportStore = new ReportStore();
  const settings = new SettingsStore();

  const now = new Date();
  let fromDate = $state(`${now.getFullYear()}-01-01`);
  let toDate = $state(now.toISOString().slice(0, 10));
  let generated = $state(false);

  const filteredLines = $derived(
    reportStore.gainLossReport
      ? filterHiddenGainLoss(reportStore.gainLossReport.lines, settings.showSpam ? new Set<string>() : getSpamCurrencySet())
      : [],
  );

  async function generate() {
    generated = false;
    await reportStore.loadGainLossReport(fromDate, toDate);
    generated = true;
  }

  function totalGainLoss(): number {
    return filteredLines.reduce((sum, line) => sum + parseFloat(line.gain_loss), 0);
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Gain/Loss Report</h1>
    <p class="text-muted-foreground">Realized capital gains and losses from lot disposals.</p>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>Report Period</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex items-end gap-4">
        <div class="space-y-1">
          <label for="from" class="text-sm font-medium">From</label>
          <Input id="from" type="date" bind:value={fromDate} class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="to" class="text-sm font-medium">To</label>
          <Input id="to" type="date" bind:value={toDate} class="w-40" />
        </div>
        <Button onclick={generate} disabled={reportStore.loading}>
          {reportStore.loading ? "Generating..." : "Generate"}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if reportStore.loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if generated}
    <!-- Summary -->
    <Card.Root>
      <Card.Header>
        <Card.Description>Total Realized Gain/Loss</Card.Description>
        {@const total = totalGainLoss()}
        <Card.Title class="text-2xl {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
          {total >= 0 ? "+" : ""}{formatCurrency(total, settings.currency)}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    <!-- Details table -->
    {#if filteredLines.length === 0}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No lot disposals in this period.
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Card.Root>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Currency</Table.Head>
              <Table.Head>Acquired</Table.Head>
              <Table.Head>Disposed</Table.Head>
              <Table.Head class="text-right">Quantity</Table.Head>
              <Table.Head class="text-right">Cost Basis</Table.Head>
              <Table.Head class="text-right">Proceeds</Table.Head>
              <Table.Head class="text-right">Gain/Loss</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each filteredLines as line (line.lot_id + line.disposed_date)}
              {@const gl = parseFloat(line.gain_loss)}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                <Table.Cell class="text-muted-foreground">{line.acquired_date}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{line.disposed_date}</Table.Cell>
                <Table.Cell class="text-right font-mono">{line.quantity}</Table.Cell>
                <Table.Cell class="text-right font-mono">{formatCurrency(line.cost_basis, settings.currency)}</Table.Cell>
                <Table.Cell class="text-right font-mono">{formatCurrency(line.proceeds, settings.currency)}</Table.Cell>
                <Table.Cell class="text-right font-mono {gl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                  {gl >= 0 ? "+" : ""}{formatCurrency(gl, settings.currency)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={6} class="font-medium">Total</Table.Cell>
              {@const total = totalGainLoss()}
              <Table.Cell class="text-right font-mono font-medium {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                {total >= 0 ? "+" : ""}{formatCurrency(total, settings.currency)}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </Card.Root>
    {/if}
  {/if}
</div>
