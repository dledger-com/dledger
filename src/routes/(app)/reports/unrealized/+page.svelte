<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { getBackend } from "$lib/backend.js";
  import { computeUnrealizedGainLoss } from "$lib/utils/unrealized-gains.js";
  import { exportUnrealizedGainLossCsv } from "$lib/utils/csv-export.js";
  import {
    findMissingRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import type { UnrealizedGainLossReport } from "$lib/types/index.js";
  import Download from "lucide-svelte/icons/download";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";

  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let report = $state<UnrealizedGainLossReport | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);
  let error = $state<string | null>(null);
  let filterProtocol = $state("");
  let searchTerm = $state("");

  const uniqueProtocols = $derived(
    report
      ? [...new Set(report.lines.map((l) => l.source_handler).filter((h): h is string => !!h))].sort()
      : [],
  );

  const hasProtocols = $derived(uniqueProtocols.length > 0);

  const filteredLines = $derived.by(() => {
    if (!report) return [];
    let lines = filterProtocol
      ? report.lines.filter((l) => l.source_handler === filterProtocol)
      : report.lines;
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      lines = lines.filter(
        (l) =>
          l.currency.toLowerCase().includes(term) ||
          l.account_name.toLowerCase().includes(term) ||
          (l.source_handler && l.source_handler.toLowerCase().includes(term)),
      );
    }
    return lines;
  });

  type UnrealizedSortKey = "currency" | "protocol" | "account" | "acquired" | "quantity" | "costUnit" | "currentValue" | "unrealizedGL";
  const sortU = createSortState<UnrealizedSortKey>();
  const unrealizedAccessors: Record<UnrealizedSortKey, (line: any) => string | number | null> = {
    currency: (l) => l.currency,
    protocol: (l) => l.source_handler || "",
    account: (l) => l.account_name,
    acquired: (l) => l.acquired_date,
    quantity: (l) => parseFloat(l.quantity),
    costUnit: (l) => parseFloat(l.cost_basis_per_unit),
    currentValue: (l) => parseFloat(l.current_value),
    unrealizedGL: (l) => parseFloat(l.unrealized_gain_loss),
  };

  async function generate() {
    loading = true;
    error = null;
    report = null;
    missingRateRequests = [];
    filterProtocol = "";
    try {
      const result = await computeUnrealizedGainLoss(getBackend(), {
        baseCurrency: settings.currency,
        asOfDate: asOf,
      });
      report = result.report;
      if (result.missingCurrencyDates.length > 0) {
        missingRateRequests = await findMissingRates(
          getBackend(),
          settings.currency,
          result.missingCurrencyDates,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">As of Date</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? "Loading..." : "Generate"}
    </Button>
    {#if report}
      <Button variant="outline" onclick={() => exportUnrealizedGainLossCsv(report!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
    {/if}
    {#if hasProtocols}
      <div class="space-y-2">
        <span class="text-sm font-medium">Protocol</span>
        <Select.Root type="single" bind:value={filterProtocol}>
          <Select.Trigger class="w-40">
            {filterProtocol || "All"}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="">All</Select.Item>
            {#each uniqueProtocols as protocol (protocol)}
              <Select.Item value={protocol}>{protocol}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    {/if}
    <ListFilter bind:value={searchTerm} placeholder="Filter positions..." />
  </div>

  <MissingRateBanner requests={missingRateRequests} onFetched={generate} />

  {#if loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if report}
    <!-- Summary -->
    {@const total = parseFloat(report.total_unrealized)}
    <Card.Root>
      <Card.Header>
        <Card.Description>Total Unrealized Gain/Loss</Card.Description>
        <Card.Title class="text-2xl {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
          {total >= 0 ? "+" : ""}{formatCurrency(total, report.base_currency)}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    {#if filteredLines.length === 0}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No open lots. All positions have been fully disposed.
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Card.Root>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortU.key === "currency"} direction={sortU.direction} onclick={() => sortU.toggle("currency")}>Currency</SortableHeader>
              {#if hasProtocols}
                <SortableHeader active={sortU.key === "protocol"} direction={sortU.direction} onclick={() => sortU.toggle("protocol")}>Protocol</SortableHeader>
              {/if}
              <SortableHeader active={sortU.key === "account"} direction={sortU.direction} onclick={() => sortU.toggle("account")} class="hidden md:table-cell">Account</SortableHeader>
              <SortableHeader active={sortU.key === "acquired"} direction={sortU.direction} onclick={() => sortU.toggle("acquired")} class="hidden lg:table-cell">Acquired</SortableHeader>
              <SortableHeader active={sortU.key === "quantity"} direction={sortU.direction} onclick={() => sortU.toggle("quantity")} class="text-right hidden md:table-cell">Quantity</SortableHeader>
              <SortableHeader active={sortU.key === "costUnit"} direction={sortU.direction} onclick={() => sortU.toggle("costUnit")} class="text-right hidden sm:table-cell">Cost/Unit</SortableHeader>
              <SortableHeader active={sortU.key === "currentValue"} direction={sortU.direction} onclick={() => sortU.toggle("currentValue")} class="text-right hidden sm:table-cell">Current Value</SortableHeader>
              <SortableHeader active={sortU.key === "unrealizedGL"} direction={sortU.direction} onclick={() => sortU.toggle("unrealizedGL")} class="text-right">Unrealized G/L</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedLines = sortU.key && sortU.direction ? sortItems(filteredLines, unrealizedAccessors[sortU.key], sortU.direction) : filteredLines}
            {#each sortedLines as line}
              {@const gl = parseFloat(line.unrealized_gain_loss)}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                {#if hasProtocols}
                  <Table.Cell class="text-sm text-muted-foreground">{line.source_handler || ""}</Table.Cell>
                {/if}
                <Table.Cell class="text-sm hidden md:table-cell">{line.account_name}</Table.Cell>
                <Table.Cell class="text-muted-foreground hidden lg:table-cell">{line.acquired_date}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden md:table-cell">{line.quantity}</Table.Cell>
                <Table.Cell class="text-right font-mono hidden sm:table-cell">
                  {formatCurrency(parseFloat(line.cost_basis_per_unit), line.cost_basis_currency)}
                </Table.Cell>
                <Table.Cell class="text-right font-mono hidden sm:table-cell">
                  {formatCurrency(parseFloat(line.current_value), report.base_currency)}
                </Table.Cell>
                <Table.Cell class="text-right font-mono {gl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                  {gl >= 0 ? "+" : ""}{formatCurrency(gl, report.base_currency)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={hasProtocols ? 7 : 6} class="font-medium">Total</Table.Cell>
              <Table.Cell class="text-right font-mono font-medium {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                {total >= 0 ? "+" : ""}{formatCurrency(total, report.base_currency)}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </Card.Root>
    {/if}
  {/if}
</div>
