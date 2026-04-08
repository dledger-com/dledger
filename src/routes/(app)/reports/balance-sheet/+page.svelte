<svelte:head><title>Balance Sheet · dLedger</title></svelte:head>

<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenTrialLines, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { convertBalances, type ConvertedSummary } from "$lib/utils/currency-convert.js";
  import { getBackend } from "$lib/backend.js";
  import {
    findMissingRates,
    resolveDpriceAssets,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import { exportBalanceSheetCsv } from "$lib/utils/csv-export.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import Download from "lucide-svelte/icons/download";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";
  import type { ReportSection, CurrencyBalance } from "$lib/types/index.js";
  import * as m from "$paraglide/messages.js";

  type BSortKey = "account" | "balance";
  const bsSort = createSortState<BSortKey>();

  const store = new ReportStore();
  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let convertToBase = $state(false);

  // Conversion state
  let assetsSummary = $state<ConvertedSummary | null>(null);
  let liabilitiesSummary = $state<ConvertedSummary | null>(null);
  let equitySummary = $state<ConvertedSummary | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);

  async function generate() {
    await store.enqueueBalanceSheet(asOf);
    if (convertToBase && store.balanceSheet) {
      await runConversion();
    }
  }

  async function runConversion() {
    if (!store.balanceSheet) return;
    const baseCurrency = settings.currency;
    const hidden = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();
    assetsSummary = await convertBalances(filterHiddenBalances(store.balanceSheet.assets.totals, hidden), baseCurrency, asOf);
    liabilitiesSummary = await convertBalances(filterHiddenBalances(store.balanceSheet.liabilities.totals, hidden), baseCurrency, asOf);
    equitySummary = await convertBalances(filterHiddenBalances(store.balanceSheet.equity.totals, hidden), baseCurrency, asOf);

    // Collect all missing rate dates
    const allMissing = [
      ...(assetsSummary.missingDates || []),
      ...(liabilitiesSummary.missingDates || []),
      ...(equitySummary.missingDates || []),
    ];
    if (allMissing.length > 0) {
      const currencies = [...new Set(allMissing.map((d) => d.currency))];
      const rateConfig = settings.buildRateConfig();
      const dpriceAssets = await resolveDpriceAssets(rateConfig, currencies);
      missingRateRequests = await findMissingRates(
        getBackend(),
        baseCurrency,
        allMissing,
        dpriceAssets,
        undefined,
        rateConfig.disabledSources,
      );
    } else {
      missingRateRequests = [];
    }
  }

  async function handleToggleConvert(value: boolean) {
    convertToBase = value;
    if (convertToBase && store.balanceSheet) {
      await runConversion();
    } else {
      assetsSummary = null;
      liabilitiesSummary = null;
      equitySummary = null;
      missingRateRequests = [];
    }
  }

  function renderTotals(section: ReportSection): string {
    const totals = filterHiddenBalances(section.totals, settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
    if (totals.length === 0) return formatCurrency(0, settings.currency);
    return totals.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
  }

  function renderConvertedTotal(summary: ConvertedSummary | null): string {
    if (!summary) return "";
    return formatCurrency(summary.total, summary.baseCurrency);
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
    {#if store.balanceSheet}
      <Button variant="outline" onclick={() => exportBalanceSheetCsv(store.balanceSheet!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
      <label class="flex items-center gap-2 text-sm">
        <Switch checked={convertToBase} onCheckedChange={handleToggleConvert} />
        {m.report_convert_to({ currency: settings.currency })}
      </label>
    {/if}
  </div>

  <MissingRateBanner requests={missingRateRequests} onFetched={runConversion} />

  {#if store.loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if store.balanceSheet}
    {@const report = store.balanceSheet}

    {#if convertToBase && assetsSummary && liabilitiesSummary}
      <Card.Root class="border-primary/30">
        <Card.Header>
          <Card.Description>{m.chart_net_worth()}</Card.Description>
          <Card.Title class="text-2xl">
            {formatCurrency(
              (assetsSummary?.total ?? 0) + (liabilitiesSummary?.total ?? 0),
              settings.currency
            )}
          </Card.Title>
        </Card.Header>
      </Card.Root>
    {/if}

    {#each [
      { section: report.assets, summary: assetsSummary },
      { section: report.liabilities, summary: liabilitiesSummary },
      { section: report.equity, summary: equitySummary },
    ] as { section, summary } (section.title)}
      {@const filteredLines = filterHiddenTrialLines(section.lines, settings.showHidden ? new Set<string>() : getHiddenCurrencySet())}
      <Card.Root>
        <Card.Header>
          <Card.Title>{section.title}</Card.Title>
        </Card.Header>
        {#if filteredLines.length === 0}
          <Card.Content>
            <EmptyState message={m.empty_no_accounts()} />
          </Card.Content>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <SortableHeader active={bsSort.key === "account"} direction={bsSort.direction} onclick={() => bsSort.toggle("account")}>{m.label_account()}</SortableHeader>
                <SortableHeader active={bsSort.key === "balance"} direction={bsSort.direction} onclick={() => bsSort.toggle("balance")} class="text-right">{m.label_balance()}</SortableHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {@const sortedLines = bsSort.key && bsSort.direction ? sortItems(filteredLines, bsSort.key === "account" ? (l) => l.account_name : (l) => parseFloat(l.balances[0]?.amount ?? "0"), bsSort.direction) : filteredLines}
              {#each sortedLines as line (line.account_id)}
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
                <Table.Cell>{m.report_total()} {section.title}</Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {renderTotals(section)}
                  {#if convertToBase && summary}
                    <span class="ml-2 text-primary">({renderConvertedTotal(summary)})</span>
                    {#if summary.unconverted.length > 0}
                      <span class="ml-1 text-xs text-amber-600">
                        {m.report_unconverted_count({ count: summary.unconverted.length })}
                      </span>
                    {/if}
                    {#if settings.debugMode}
                      <ConversionDebugDialog {summary} label={section.title} />
                    {/if}
                  {/if}
                </Table.Cell>
              </Table.Row>
            </Table.Footer>
          </Table.Root>
        {/if}
      </Card.Root>
    {/each}
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <EmptyState message={m.empty_no_balance_sheet_data()} />
      </Card.Content>
    </Card.Root>
  {/if}
</div>
