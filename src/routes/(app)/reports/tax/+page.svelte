<svelte:head><title>{m.report_tax()} · dLedger</title></svelte:head>

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
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import Download from "lucide-svelte/icons/download";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import CoinIcon from "$lib/components/CoinIcon.svelte";
  import * as m from "$paraglide/messages.js";

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
    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:tax:${fromDate}:${toDate}`,
        label: m.report_tax_summary(),
        description: `${fromDate} to ${toDate}`,
        run: async () => {
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
            resolve();
          }
          return { summary: "Tax summary generated" };
        },
      });
      if (id === null) {
        loading = false;
        resolve();
      }
    });
  }
</script>

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>{m.report_parameters()}</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex items-end gap-4 flex-wrap">
        <div class="space-y-1">
          <label for="from" class="text-sm font-medium">{m.label_from()}</label>
          <Input id="from" type="date" bind:value={fromDate} class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="to" class="text-sm font-medium">{m.label_to()}</label>
          <Input id="to" type="date" bind:value={toDate} class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="holding" class="text-sm font-medium">{m.report_holding_period()}</label>
          <Input id="holding" type="number" bind:value={holdingPeriodDays} class="w-32" min="1" />
        </div>
        <Button onclick={generate} disabled={loading}>
          {loading ? m.state_generating() : m.btn_generate()}
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
          <Card.Description>{m.report_short_term_gains()}</Card.Description>
          <Card.Title class="text-xl text-positive">
            +{formatCurrency(stGains, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_short_term_losses()}</Card.Description>
          <Card.Title class="text-xl text-negative">
            {formatCurrency(stLosses, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_long_term_gains()}</Card.Description>
          <Card.Title class="text-xl text-positive">
            +{formatCurrency(ltGains, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_long_term_losses()}</Card.Description>
          <Card.Title class="text-xl text-negative">
            {formatCurrency(ltLosses, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_total_realized()}</Card.Description>
          <Card.Title class="text-xl {totalRealized >= 0 ? 'text-positive' : 'text-negative'}">
            {totalRealized >= 0 ? "+" : ""}{formatCurrency(totalRealized, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_unrealized_label()}</Card.Description>
          <Card.Title class="text-xl {totalUnrealized >= 0 ? 'text-positive' : 'text-negative'}">
            {totalUnrealized >= 0 ? "+" : ""}{formatCurrency(totalUnrealized, settings.currency)}
          </Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>{m.report_total_income()}</Card.Description>
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
          <Card.Title>{m.report_realized_gl_details()}</Card.Title>
        </Card.Header>
        <Table.Root class="table-fixed">
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortGL.key === "type"} direction={sortGL.direction} onclick={() => sortGL.toggle("type")} class="w-16 sm:w-20">{m.label_type()}</SortableHeader>
              <SortableHeader active={sortGL.key === "currency"} direction={sortGL.direction} onclick={() => sortGL.toggle("currency")}>{m.label_currency()}</SortableHeader>
              <SortableHeader active={sortGL.key === "acquired"} direction={sortGL.direction} onclick={() => sortGL.toggle("acquired")} class="hidden lg:table-cell w-28">{m.report_acquired()}</SortableHeader>
              <SortableHeader active={sortGL.key === "disposed"} direction={sortGL.direction} onclick={() => sortGL.toggle("disposed")} class="hidden lg:table-cell w-28">{m.report_disposed()}</SortableHeader>
              <SortableHeader active={sortGL.key === "quantity"} direction={sortGL.direction} onclick={() => sortGL.toggle("quantity")} class="text-right hidden md:table-cell w-24">{m.report_quantity()}</SortableHeader>
              <SortableHeader active={sortGL.key === "costBasis"} direction={sortGL.direction} onclick={() => sortGL.toggle("costBasis")} class="text-right hidden sm:table-cell w-28">{m.report_cost_basis()}</SortableHeader>
              <SortableHeader active={sortGL.key === "proceeds"} direction={sortGL.direction} onclick={() => sortGL.toggle("proceeds")} class="text-right hidden sm:table-cell w-28">{m.report_proceeds()}</SortableHeader>
              <SortableHeader active={sortGL.key === "gainLoss"} direction={sortGL.direction} onclick={() => sortGL.toggle("gainLoss")} class="text-right w-28 sm:w-32">{m.report_gain_loss_col()}</SortableHeader>
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
                  <span class="inline-flex items-center gap-1 min-w-0 max-w-full"><CoinIcon code={line.currency} size={14} /><Badge variant="outline" class="truncate max-w-full" title={line.currency}>{line.currency}</Badge></span>
                </Table.Cell>
                <Table.Cell class="text-muted-foreground hidden lg:table-cell">{line.acquired_date}</Table.Cell>
                <Table.Cell class="text-muted-foreground hidden lg:table-cell">{line.disposed_date}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden md:table-cell">{line.quantity}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden sm:table-cell">{formatCurrency(line.cost_basis, settings.currency)}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden sm:table-cell">{formatCurrency(line.proceeds, settings.currency)}</Table.Cell>
                <Table.Cell class="text-right font-mono {gl >= 0 ? 'text-positive' : 'text-negative'}">
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
            {m.empty_no_lot_disposals()}
          </p>
        </Card.Content>
      </Card.Root>
    {/if}

    <!-- Income by Account Table -->
    {#if summary.income_by_account.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>{m.report_income_by_account()}</Card.Title>
        </Card.Header>
        <Table.Root class="table-fixed">
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortInc.key === "account"} direction={sortInc.direction} onclick={() => sortInc.toggle("account")}>{m.label_account()}</SortableHeader>
              <SortableHeader active={sortInc.key === "currency"} direction={sortInc.direction} onclick={() => sortInc.toggle("currency")} class="w-28 sm:w-40">{m.label_currency()}</SortableHeader>
              <SortableHeader active={sortInc.key === "amount"} direction={sortInc.direction} onclick={() => sortInc.toggle("amount")} class="text-right w-28 sm:w-40">{m.label_amount()}</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedInc = sortInc.key && sortInc.direction ? sortItems(summary.income_by_account, incAccessors[sortInc.key], sortInc.direction) : summary.income_by_account}
            {#each sortedInc as inc}
              <Table.Row>
                <Table.Cell>
                  <span class="block truncate" title={inc.account_name}>{inc.account_name}</span>
                </Table.Cell>
                <Table.Cell>
                  <span class="inline-flex items-center gap-1 min-w-0 max-w-full"><CoinIcon code={inc.currency} size={14} /><Badge variant="outline" class="truncate max-w-full" title={inc.currency}>{inc.currency}</Badge></span>
                </Table.Cell>
                <Table.Cell class="text-right font-mono whitespace-normal break-words">{formatCurrency(inc.amount, inc.currency)}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={2} class="font-medium">{m.report_total_income()}</Table.Cell>
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
            {m.empty_no_income_recorded()}
          </p>
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
