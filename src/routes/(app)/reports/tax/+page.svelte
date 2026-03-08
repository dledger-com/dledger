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
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";

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

  type GLSortKey = "type" | "currency" | "acquired" | "disposed" | "quantity" | "costBasis" | "proceeds" | "gainLoss";
  const sortGL = createSortState<GLSortKey>();
  const glAccessors: Record<GLSortKey, (l: any) => string | number | null> = {
    type: (l) => l.is_long_term ? "LT" : "ST",
    currency: (l) => l.currency,
    acquired: (l) => l.acquired_date,
    disposed: (l) => l.disposed_date,
    quantity: (l) => parseFloat(l.quantity),
    costBasis: (l) => parseFloat(l.cost_basis),
    proceeds: (l) => parseFloat(l.proceeds),
    gainLoss: (l) => parseFloat(l.gain_loss),
  };

  type IncSortKey = "account" | "currency" | "amount";
  const sortInc = createSortState<IncSortKey>();
  const incAccessors: Record<IncSortKey, (i: any) => string | number | null> = {
    account: (i) => i.account_name,
    currency: (i) => i.currency,
    amount: (i) => parseFloat(i.amount),
  };

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
              <SortableHeader active={sortGL.key === "type"} direction={sortGL.direction} onclick={() => sortGL.toggle("type")}>Type</SortableHeader>
              <SortableHeader active={sortGL.key === "currency"} direction={sortGL.direction} onclick={() => sortGL.toggle("currency")}>Currency</SortableHeader>
              <SortableHeader active={sortGL.key === "acquired"} direction={sortGL.direction} onclick={() => sortGL.toggle("acquired")}>Acquired</SortableHeader>
              <SortableHeader active={sortGL.key === "disposed"} direction={sortGL.direction} onclick={() => sortGL.toggle("disposed")}>Disposed</SortableHeader>
              <SortableHeader active={sortGL.key === "quantity"} direction={sortGL.direction} onclick={() => sortGL.toggle("quantity")} class="text-right">Quantity</SortableHeader>
              <SortableHeader active={sortGL.key === "costBasis"} direction={sortGL.direction} onclick={() => sortGL.toggle("costBasis")} class="text-right">Cost Basis</SortableHeader>
              <SortableHeader active={sortGL.key === "proceeds"} direction={sortGL.direction} onclick={() => sortGL.toggle("proceeds")} class="text-right">Proceeds</SortableHeader>
              <SortableHeader active={sortGL.key === "gainLoss"} direction={sortGL.direction} onclick={() => sortGL.toggle("gainLoss")} class="text-right">Gain/Loss</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedGL = sortGL.key && sortGL.direction ? sortItems(summary.gain_loss_lines, glAccessors[sortGL.key], sortGL.direction) : summary.gain_loss_lines}
            {#each sortedGL as line (line.lot_id + line.disposed_date)}
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
              <SortableHeader active={sortInc.key === "account"} direction={sortInc.direction} onclick={() => sortInc.toggle("account")}>Account</SortableHeader>
              <SortableHeader active={sortInc.key === "currency"} direction={sortInc.direction} onclick={() => sortInc.toggle("currency")}>Currency</SortableHeader>
              <SortableHeader active={sortInc.key === "amount"} direction={sortInc.direction} onclick={() => sortInc.toggle("amount")} class="text-right">Amount</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedInc = sortInc.key && sortInc.direction ? sortItems(summary.income_by_account, incAccessors[sortInc.key], sortInc.direction) : summary.income_by_account}
            {#each sortedInc as inc}
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
