<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
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
  import { exportIncomeStatementCsv } from "$lib/utils/csv-export.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import Download from "lucide-svelte/icons/download";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";
  import type { ReportSection } from "$lib/types/index.js";
  import * as m from "$paraglide/messages.js";

  type ISSortKey = "account" | "balance";
  const isSort = createSortState<ISSortKey>();

  const store = new ReportStore();
  const settings = new SettingsStore();
  let fromDate = $state(`${new Date().getFullYear()}-01-01`);
  let toDate = $state(new Date().toISOString().slice(0, 10));
  let convertToBase = $state(false);

  // Conversion state
  let revenueSummary = $state<ConvertedSummary | null>(null);
  let expensesSummary = $state<ConvertedSummary | null>(null);
  let netIncomeSummary = $state<ConvertedSummary | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);

  async function generate() {
    await store.enqueueIncomeStatement(fromDate, toDate);
    if (convertToBase && store.incomeStatement) {
      await runConversion();
    }
  }

  async function runConversion() {
    if (!store.incomeStatement) return;
    const baseCurrency = settings.currency;
    const hidden = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();
    revenueSummary = await convertBalances(filterHiddenBalances(store.incomeStatement.revenue.totals, hidden), baseCurrency, toDate);
    expensesSummary = await convertBalances(filterHiddenBalances(store.incomeStatement.expenses.totals, hidden), baseCurrency, toDate);
    netIncomeSummary = await convertBalances(filterHiddenBalances(store.incomeStatement.net_income, hidden), baseCurrency, toDate);

    const allMissing = [
      ...(revenueSummary.missingDates || []),
      ...(expensesSummary.missingDates || []),
      ...(netIncomeSummary.missingDates || []),
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
    if (convertToBase && store.incomeStatement) {
      await runConversion();
    } else {
      revenueSummary = null;
      expensesSummary = null;
      netIncomeSummary = null;
      missingRateRequests = [];
    }
  }

  function renderTotals(section: ReportSection): string {
    const totals = filterHiddenBalances(section.totals, settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
    if (totals.length === 0) return formatCurrency(0, settings.currency);
    return totals.map((b) => formatCurrency(Math.abs(parseFloat(b.amount)), b.currency)).join(", ");
  }

  function renderConvertedTotal(summary: ConvertedSummary | null): string {
    if (!summary) return "";
    return formatCurrency(Math.abs(summary.total), summary.baseCurrency);
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="from" class="text-sm font-medium">{m.label_from()}</label>
      <Input id="from" type="date" bind:value={fromDate} class="w-full sm:w-48" />
    </div>
    <div class="space-y-2">
      <label for="to" class="text-sm font-medium">{m.label_to()}</label>
      <Input id="to" type="date" bind:value={toDate} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={store.loading}>
      {store.loading ? m.state_loading_report() : m.btn_generate()}
    </Button>
    {#if store.incomeStatement}
      <Button variant="outline" onclick={() => exportIncomeStatementCsv(store.incomeStatement!)}>
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
  {:else if store.incomeStatement}
    {@const report = store.incomeStatement}
    {@const hidden = settings.showHidden ? new Set<string>() : getHiddenCurrencySet()}
    <Card.Root>
      <Card.Header><Card.Title>{m.report_revenue()}</Card.Title></Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={isSort.key === "account"} direction={isSort.direction} onclick={() => isSort.toggle("account")}>{m.label_account()}</SortableHeader>
            <SortableHeader active={isSort.key === "balance"} direction={isSort.direction} onclick={() => isSort.toggle("balance")} class="text-right">{m.label_amount()}</SortableHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const lines = filterHiddenTrialLines(report.revenue.lines, hidden)}
          {@const sortedLines = isSort.key && isSort.direction ? sortItems(lines, isSort.key === "account" ? (l) => l.account_name : (l) => Math.abs(parseFloat(l.balances[0]?.amount ?? "0")), isSort.direction) : lines}
          {#each sortedLines as line (line.account_id)}
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
            <Table.Cell>{m.report_total_revenue()}</Table.Cell>
            <Table.Cell class="text-right font-mono">
              {renderTotals(report.revenue)}
              {#if convertToBase && revenueSummary}
                <span class="ml-2 text-primary">({renderConvertedTotal(revenueSummary)})</span>
                {#if settings.debugMode}
                  <ConversionDebugDialog summary={revenueSummary} label={m.report_revenue()} />
                {/if}
              {/if}
            </Table.Cell>
          </Table.Row>
        </Table.Footer>
      </Table.Root>
    </Card.Root>

    <Card.Root>
      <Card.Header><Card.Title>{m.report_expenses()}</Card.Title></Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={isSort.key === "account"} direction={isSort.direction} onclick={() => isSort.toggle("account")}>{m.label_account()}</SortableHeader>
            <SortableHeader active={isSort.key === "balance"} direction={isSort.direction} onclick={() => isSort.toggle("balance")} class="text-right">{m.label_amount()}</SortableHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const lines = filterHiddenTrialLines(report.expenses.lines, hidden)}
          {@const sortedLines = isSort.key && isSort.direction ? sortItems(lines, isSort.key === "account" ? (l) => l.account_name : (l) => Math.abs(parseFloat(l.balances[0]?.amount ?? "0")), isSort.direction) : lines}
          {#each sortedLines as line (line.account_id)}
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
            <Table.Cell>{m.report_total_expenses()}</Table.Cell>
            <Table.Cell class="text-right font-mono">
              {renderTotals(report.expenses)}
              {#if convertToBase && expensesSummary}
                <span class="ml-2 text-primary">({renderConvertedTotal(expensesSummary)})</span>
                {#if settings.debugMode}
                  <ConversionDebugDialog summary={expensesSummary} label={m.report_expenses()} />
                {/if}
              {/if}
            </Table.Cell>
          </Table.Row>
        </Table.Footer>
      </Table.Root>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Description>{m.report_net_income()}</Card.Description>
        <Card.Title class="text-2xl">
          {filterHiddenBalances(report.net_income, hidden).length === 0
            ? formatCurrency(0, settings.currency)
            : filterHiddenBalances(report.net_income, hidden).map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
          {#if convertToBase && netIncomeSummary}
            <span class="ml-2 text-lg text-primary">({renderConvertedTotal(netIncomeSummary)})</span>
            {#if settings.debugMode}
              <ConversionDebugDialog summary={netIncomeSummary} label={m.report_net_income()} />
            {/if}
          {/if}
        </Card.Title>
      </Card.Header>
    </Card.Root>
  {:else}
    <EmptyState message={m.empty_no_income_statement_data()} />
  {/if}
</div>
