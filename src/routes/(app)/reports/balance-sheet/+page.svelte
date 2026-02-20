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
  import { filterHiddenTrialLines, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { convertBalances, type ConvertedSummary } from "$lib/utils/currency-convert.js";
  import { getBackend } from "$lib/backend.js";
  import {
    findMissingRates,
    fetchHistoricalRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import { markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";
  import { exportBalanceSheetCsv } from "$lib/utils/csv-export.js";
  import Download from "lucide-svelte/icons/download";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";
  import type { ReportSection, CurrencyBalance } from "$lib/types/index.js";

  const store = new ReportStore();
  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let convertToBase = $state(false);

  // Conversion state
  let assetsSummary = $state<ConvertedSummary | null>(null);
  let liabilitiesSummary = $state<ConvertedSummary | null>(null);
  let equitySummary = $state<ConvertedSummary | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);
  let fetchingRates = $state(false);

  async function generate() {
    await store.loadBalanceSheet(asOf);
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
      missingRateRequests = await findMissingRates(
        getBackend(),
        baseCurrency,
        allMissing,
      );
    } else {
      missingRateRequests = [];
    }
  }

  async function handleToggleConvert() {
    convertToBase = !convertToBase;
    if (convertToBase && store.balanceSheet) {
      await runConversion();
    } else {
      assetsSummary = null;
      liabilitiesSummary = null;
      equitySummary = null;
      missingRateRequests = [];
    }
  }

  async function handleFetchMissingRates() {
    fetchingRates = true;
    try {
      const result = await fetchHistoricalRates(
        getBackend(),
        missingRateRequests,
        {
          baseCurrency: settings.currency,
          coingeckoApiKey: settings.coingeckoApiKey,
          finnhubApiKey: settings.finnhubApiKey,
        },
      );
      missingRateRequests = [];

      // Auto-hide currencies that failed all sources
      if (result.failedCurrencies.length > 0) {
        const backend = getBackend();
        for (const code of result.failedCurrencies) {
          await backend.setCurrencyRateSource(code, "none", "auto");
          await markCurrencyHidden(backend, code);
        }
        showAutoHideToast(result.failedCurrencies);
      }

      // Re-run conversion with new rates
      await runConversion();
      if (result.failedCurrencies.length > 0) {
        toast.success(`Fetched ${result.fetched} rate(s), auto-hid ${result.failedCurrencies.length} currency(ies)`);
      } else {
        toast.success("Missing rates fetched");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      fetchingRates = false;
    }
  }

  function renderTotals(section: ReportSection): string {
    const totals = filterHiddenBalances(section.totals, settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
    if (totals.length === 0) return formatCurrency(0);
    return totals.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
  }

  function renderConvertedTotal(summary: ConvertedSummary | null): string {
    if (!summary) return "";
    return formatCurrency(summary.total, summary.baseCurrency);
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
    {#if store.balanceSheet}
      <Button variant="outline" onclick={() => exportBalanceSheetCsv(store.balanceSheet!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
      <Button variant="outline" onclick={handleToggleConvert}>
        {convertToBase ? `Show native currencies` : `Convert to ${settings.currency}`}
      </Button>
    {/if}
  </div>

  {#if missingRateRequests.length > 0}
    <Card.Root class="border-amber-200 dark:border-amber-800">
      <Card.Content class="flex items-center justify-between py-3">
        <div class="flex items-center gap-2">
          <span class="text-sm">
            Missing rates for {missingRateRequests.map((r) => r.currency).join(", ")} on {asOf}.
          </span>
        </div>
        <Button size="sm" onclick={handleFetchMissingRates} disabled={fetchingRates}>
          {fetchingRates ? "Fetching..." : "Fetch Missing Rates"}
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if store.loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if store.balanceSheet}
    {@const report = store.balanceSheet}

    {#if convertToBase && assetsSummary && liabilitiesSummary}
      <Card.Root class="border-primary/30">
        <Card.Header>
          <Card.Description>Net Worth</Card.Description>
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
                <Table.Cell class="text-right font-mono">
                  {renderTotals(section)}
                  {#if convertToBase && summary}
                    <span class="ml-2 text-primary">({renderConvertedTotal(summary)})</span>
                    {#if summary.unconverted.length > 0}
                      <span class="ml-1 text-xs text-amber-600">
                        +{summary.unconverted.length} unconverted
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
        <p class="text-sm text-muted-foreground text-center">
          No data available. Post journal entries to generate the balance sheet.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
