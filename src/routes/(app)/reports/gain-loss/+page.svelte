<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenGainLoss } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { exportGainLossCsv } from "$lib/utils/csv-export.js";
  import Download from "lucide-svelte/icons/download";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import * as m from "$paraglide/messages.js";

  const reportStore = new ReportStore();
  const settings = new SettingsStore();

  const now = new Date();
  let fromDate = $state(`${now.getFullYear()}-01-01`);
  let toDate = $state(now.toISOString().slice(0, 10));
  let generated = $state(false);
  let filterProtocol = $state("");
  let searchTerm = $state("");

  const hiddenFiltered = $derived(
    reportStore.gainLossReport
      ? filterHiddenGainLoss(reportStore.gainLossReport.lines, settings.showHidden ? new Set<string>() : getHiddenCurrencySet())
      : [],
  );

  const uniqueProtocols = $derived(
    [...new Set(hiddenFiltered.map((l) => l.source_handler).filter((h): h is string => !!h))].sort(),
  );

  const hasProtocols = $derived(uniqueProtocols.length > 0);

  const filteredLines = $derived.by(() => {
    let lines = filterProtocol
      ? hiddenFiltered.filter((l) => l.source_handler === filterProtocol)
      : hiddenFiltered;
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      lines = lines.filter(
        (l) =>
          l.currency.toLowerCase().includes(term) ||
          (l.source_handler && l.source_handler.toLowerCase().includes(term)),
      );
    }
    return lines;
  });

  type GainLossSortKey = "currency" | "protocol" | "acquired" | "disposed" | "quantity" | "costBasis" | "proceeds" | "gainLoss";
  const sort = createSortState<GainLossSortKey>();
  const gainLossAccessors: Record<GainLossSortKey, (line: any) => string | number | null> = {
    currency: (l) => l.currency,
    protocol: (l) => l.source_handler || "",
    acquired: (l) => l.acquired_date,
    disposed: (l) => l.disposed_date,
    quantity: (l) => parseFloat(l.quantity),
    costBasis: (l) => parseFloat(l.cost_basis),
    proceeds: (l) => parseFloat(l.proceeds),
    gainLoss: (l) => parseFloat(l.gain_loss),
  };

  async function generate() {
    generated = false;
    await reportStore.enqueueGainLossReport(fromDate, toDate);
    generated = true;
  }

  function totalGainLoss(): number {
    return filteredLines.reduce((sum, line) => sum + parseFloat(line.gain_loss), 0);
  }
</script>

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>{m.report_report_period()}</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1">
          <label for="from" class="text-sm font-medium">{m.label_from()}</label>
          <Input id="from" type="date" bind:value={fromDate} class="w-full sm:w-40" />
        </div>
        <div class="space-y-1">
          <label for="to" class="text-sm font-medium">{m.label_to()}</label>
          <Input id="to" type="date" bind:value={toDate} class="w-full sm:w-40" />
        </div>
        <Button onclick={generate} disabled={reportStore.loading}>
          {reportStore.loading ? m.state_generating() : m.btn_generate()}
        </Button>
        {#if reportStore.gainLossReport}
          <Button variant="outline" onclick={() => exportGainLossCsv(reportStore.gainLossReport!)}>
            <Download class="mr-1 h-4 w-4" />
            CSV
          </Button>
        {/if}
        {#if hasProtocols}
          <div class="space-y-1">
            <span class="text-sm font-medium">{m.report_protocol()}</span>
            <Select.Root type="single" bind:value={filterProtocol}>
              <Select.Trigger class="w-40">
                {filterProtocol || m.range_all()}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="">{m.range_all()}</Select.Item>
                {#each uniqueProtocols as protocol (protocol)}
                  <Select.Item value={protocol}>{protocol}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
        <ListFilter bind:value={searchTerm} placeholder={m.placeholder_filter_lots()} />
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
        <Card.Description>{m.report_total_realized_gain_loss()}</Card.Description>
        {@const total = totalGainLoss()}
        <Card.Title class="text-2xl {total >= 0 ? 'text-positive' : 'text-negative'}">
          {total >= 0 ? "+" : ""}{formatCurrency(total, settings.currency)}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    <!-- Details table -->
    {#if filteredLines.length === 0}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            {m.report_no_lot_disposals()}
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Card.Root>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sort.key === "currency"} direction={sort.direction} onclick={() => sort.toggle("currency")}>{m.label_currency()}</SortableHeader>
              {#if hasProtocols}
                <SortableHeader active={sort.key === "protocol"} direction={sort.direction} onclick={() => sort.toggle("protocol")}>{m.report_protocol()}</SortableHeader>
              {/if}
              <SortableHeader active={sort.key === "acquired"} direction={sort.direction} onclick={() => sort.toggle("acquired")} class="hidden lg:table-cell">{m.report_acquired()}</SortableHeader>
              <SortableHeader active={sort.key === "disposed"} direction={sort.direction} onclick={() => sort.toggle("disposed")} class="hidden lg:table-cell">{m.report_disposed()}</SortableHeader>
              <SortableHeader active={sort.key === "quantity"} direction={sort.direction} onclick={() => sort.toggle("quantity")} class="text-right hidden md:table-cell">{m.report_quantity()}</SortableHeader>
              <SortableHeader active={sort.key === "costBasis"} direction={sort.direction} onclick={() => sort.toggle("costBasis")} class="text-right hidden sm:table-cell">{m.report_cost_basis()}</SortableHeader>
              <SortableHeader active={sort.key === "proceeds"} direction={sort.direction} onclick={() => sort.toggle("proceeds")} class="text-right hidden sm:table-cell">{m.report_proceeds()}</SortableHeader>
              <SortableHeader active={sort.key === "gainLoss"} direction={sort.direction} onclick={() => sort.toggle("gainLoss")} class="text-right">{m.report_gain_loss_col()}</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedLines = sort.key && sort.direction ? sortItems(filteredLines, gainLossAccessors[sort.key], sort.direction) : filteredLines}
            {#each sortedLines as line (line.lot_id + line.disposed_date)}
              {@const gl = parseFloat(line.gain_loss)}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                {#if hasProtocols}
                  <Table.Cell class="text-sm text-muted-foreground">{line.source_handler || ""}</Table.Cell>
                {/if}
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
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={hasProtocols ? 7 : 6} class="font-medium">{m.report_total()}</Table.Cell>
              {@const total = totalGainLoss()}
              <Table.Cell class="text-right font-mono font-medium {total >= 0 ? 'text-positive' : 'text-negative'}">
                {total >= 0 ? "+" : ""}{formatCurrency(total, settings.currency)}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </Card.Root>
    {/if}
  {/if}
</div>
