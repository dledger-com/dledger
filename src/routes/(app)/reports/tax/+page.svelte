<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { computeTaxSummary, computeTaxYearDates, type TaxSummary } from "$lib/utils/tax-summary.js";
  import { exportTaxSummaryCsv } from "$lib/utils/csv-export.js";
  import Download from "lucide-svelte/icons/download";

  const settings = new SettingsStore();

  const fiscalDates = computeTaxYearDates(settings.fiscalYearStart);
  let fromDate = $state(fiscalDates.from);
  let toDate = $state(fiscalDates.to);
  let holdingPeriodDays = $state(settings.holdingPeriodDays);
  let loading = $state(false);
  let summary = $state<TaxSummary | null>(null);
  let error = $state<string | null>(null);

  const totalIncome = $derived(
    summary
      ? summary.income_by_account.reduce((sum, i) => sum + parseFloat(i.amount), 0)
      : 0,
  );

  const stGains = $derived(summary ? parseFloat(summary.short_term_gains) : 0);
  const stLosses = $derived(summary ? parseFloat(summary.short_term_losses) : 0);
  const ltGains = $derived(summary ? parseFloat(summary.long_term_gains) : 0);
  const ltLosses = $derived(summary ? parseFloat(summary.long_term_losses) : 0);
  const totalRealized = $derived(summary ? parseFloat(summary.total_realized) : 0);
  const totalUnrealized = $derived(summary ? parseFloat(summary.total_unrealized) : 0);

  async function generate() {
    loading = true;
    error = null;
    summary = null;
    try {
      summary = await computeTaxSummary(getBackend(), {
        fromDate,
        toDate,
        holdingPeriodDays,
        baseCurrency: settings.currency,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Tax Summary Report</h1>
    <p class="text-muted-foreground">Capital gains classification, income summary, and unrealized positions.</p>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>Report Parameters</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex items-end gap-4 flex-wrap">
        <div class="space-y-1">
          <label for="from" class="text-sm font-medium">From</label>
          <Input id="from" type="date" bind:value={fromDate} class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="to" class="text-sm font-medium">To</label>
          <Input id="to" type="date" bind:value={toDate} class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="holding" class="text-sm font-medium">Holding Period (days)</label>
          <Input id="holding" type="number" bind:value={holdingPeriodDays} class="w-32" min="1" />
        </div>
        <Button onclick={generate} disabled={loading}>
          {loading ? "Generating..." : "Generate"}
        </Button>
        {#if summary}
          <Button variant="outline" onclick={() => exportTaxSummaryCsv(summary!)}>
            <Download class="mr-1 h-4 w-4" />
            CSV
          </Button>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>

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
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if summary}
    <!-- Summary Cards -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Short-Term Gains</Card.Description>
          <Card.Title class="text-xl text-green-600 dark:text-green-400">
            +{formatCurrency(stGains, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Short-Term Losses</Card.Description>
          <Card.Title class="text-xl text-red-600 dark:text-red-400">
            {formatCurrency(stLosses, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Long-Term Gains</Card.Description>
          <Card.Title class="text-xl text-green-600 dark:text-green-400">
            +{formatCurrency(ltGains, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Long-Term Losses</Card.Description>
          <Card.Title class="text-xl text-red-600 dark:text-red-400">
            {formatCurrency(ltLosses, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Total Realized</Card.Description>
          <Card.Title class="text-xl {totalRealized >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
            {totalRealized >= 0 ? "+" : ""}{formatCurrency(totalRealized, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Unrealized</Card.Description>
          <Card.Title class="text-xl {totalUnrealized >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
            {totalUnrealized >= 0 ? "+" : ""}{formatCurrency(totalUnrealized, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Total Income</Card.Description>
          <Card.Title class="text-xl">
            {formatCurrency(totalIncome, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>
    </div>

    <!-- Gain/Loss Detail Table -->
    {#if summary.gain_loss_lines.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Realized Gain/Loss Details</Card.Title>
        </Card.Header>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Type</Table.Head>
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
            {#each summary.gain_loss_lines as line (line.lot_id + line.disposed_date)}
              {@const gl = parseFloat(line.gain_loss)}
              <Table.Row>
                <Table.Cell>
                  <Badge variant={line.is_long_term ? "default" : "secondary"}>
                    {line.is_long_term ? "LT" : "ST"}
                  </Badge>
                </Table.Cell>
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
        </Table.Root>
      </Card.Root>
    {:else}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No lot disposals in this period.
          </p>
        </Card.Content>
      </Card.Root>
    {/if}

    <!-- Income by Account Table -->
    {#if summary.income_by_account.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Income by Account</Card.Title>
        </Card.Header>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Account</Table.Head>
              <Table.Head>Currency</Table.Head>
              <Table.Head class="text-right">Amount</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each summary.income_by_account as inc}
              <Table.Row>
                <Table.Cell>{inc.account_name}</Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">{inc.currency}</Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono">{formatCurrency(inc.amount, inc.currency)}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={2} class="font-medium">Total Income</Table.Cell>
              <Table.Cell class="text-right font-mono font-medium">
                {formatCurrency(totalIncome, settings.currency)}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </Card.Root>
    {:else}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No income recorded in this period.
          </p>
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
