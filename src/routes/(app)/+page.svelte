<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { convertBalances, type ConvertedSummary } from "$lib/utils/currency-convert.js";
  import { computeNetWorthSeries, computeExpenseBreakdown, type NetWorthPoint, type ExpenseCategory } from "$lib/utils/balance-history.js";
  import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
  import { getBackend } from "$lib/backend.js";
  import { countDueTemplates } from "$lib/utils/recurring.js";
  import { toast } from "svelte-sonner";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";
  import { AreaChart, PieChart } from "layerchart";
  import { scaleTime, scaleLinear } from "d3-scale";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();
  const reportStore = new ReportStore();
  const settings = new SettingsStore();

  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  let ready = $state(false);
  let assetsSummary = $state<ConvertedSummary | null>(null);
  let liabilitiesSummary = $state<ConvertedSummary | null>(null);
  let revenueSummary = $state<ConvertedSummary | null>(null);
  let netIncomeSummary = $state<ConvertedSummary | null>(null);
  let showAssets = $state(false);
  let showLiabilities = $state(false);
  let showRevenue = $state(false);
  let showNetIncome = $state(false);

  // Charts
  let netWorthData = $state<NetWorthPoint[]>([]);
  let expenseData = $state<ExpenseCategory[]>([]);
  let chartsLoading = $state(true);

  // Persistent exchange rate cache — rates are immutable by (from, to, date)
  let rateCache: ExchangeRateCache | undefined;
  function getOrCreateRateCache() {
    if (!rateCache) rateCache = new ExchangeRateCache(getBackend());
    return rateCache;
  }

  // Date range
  type RangePreset = "ytd" | "mtd" | "12m" | "all";
  let rangePreset = $state<RangePreset>("ytd");

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function rangeFromDate(): string {
    const now = new Date();
    switch (rangePreset) {
      case "mtd":
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      case "12m": {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() - 1);
        return d.toISOString().slice(0, 10);
      }
      case "all":
        return "2000-01-01";
      case "ytd":
      default: {
        const fys = settings.fiscalYearStart || "01-01";
        return `${now.getFullYear()}-${fys}`;
      }
    }
  }

  function sumBalances(balances: { currency: string; amount: string }[]): string {
    if (balances.length === 0) return formatCurrency(0);
    return balances
      .map((b) => formatCurrency(b.amount, b.currency))
      .join(", ");
  }

  async function loadCharts(sharedCache?: ExchangeRateCache) {
    chartsLoading = true;
    try {
      const from = rangeFromDate();
      const to = today();
      const base = settings.currency;

      const backend = getBackend();
      const cache = sharedCache ?? new ExchangeRateCache(backend);
      const [nw, exp] = await Promise.all([
        computeNetWorthSeries(backend, from, to, base, cache),
        computeExpenseBreakdown(backend, from, to, base, 6, reportStore.incomeStatement ?? undefined, cache),
      ]);
      netWorthData = nw;
      expenseData = exp;
    } catch (e) {
      console.error("Charts failed:", e);
    } finally {
      chartsLoading = false;
    }
  }

  onMount(async () => {
    try {
      await Promise.all([
        accountStore.load(),
        journalStore.load({ limit: 10 }),
        reportStore.loadBalanceSheet(today()),
        reportStore.loadIncomeStatement(rangeFromDate(), today()),
      ]);
    } catch (e) {
      console.error("Dashboard load failed:", e);
    } finally {
      ready = true;
    }

    // Shared exchange rate cache for all conversions + charts
    const date = today();
    const base = settings.currency;
    const hiddenSet = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();
    const sharedCache = getOrCreateRateCache();

    try {
      const promises: Promise<void>[] = [];
      if (reportStore.balanceSheet) {
        promises.push(
          convertBalances(filterHiddenBalances(reportStore.balanceSheet.assets.totals, hiddenSet), base, date, sharedCache)
            .then(s => { assetsSummary = s; }),
          convertBalances(filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hiddenSet), base, date, sharedCache)
            .then(s => { liabilitiesSummary = s; }),
        );
      }
      if (reportStore.incomeStatement) {
        promises.push(
          convertBalances(filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hiddenSet), base, date, sharedCache)
            .then(s => { revenueSummary = s; }),
          convertBalances(filterHiddenBalances(reportStore.incomeStatement.net_income, hiddenSet), base, date, sharedCache)
            .then(s => { netIncomeSummary = s; }),
        );
      }
      await Promise.all(promises);
    } catch (e) {
      console.error("Currency conversion failed:", e);
    }

    // Load charts (non-blocking), reusing the shared cache
    loadCharts(sharedCache);

    // Check for due recurring templates
    countDueTemplates(getBackend()).then((count) => {
      if (count > 0) {
        toast.info(`${count} recurring ${count === 1 ? "template" : "templates"} due`, {
          action: { label: "Generate", onClick: () => { window.location.href = "/journal/recurring"; } },
        });
      }
    }).catch(() => {});
  });

  async function selectRange(preset: RangePreset) {
    rangePreset = preset;
    // Reload income statement first, then pass it to charts
    await reportStore.loadIncomeStatement(rangeFromDate(), today());
    loadCharts(getOrCreateRateCache());
  }
</script>

{#snippet summaryCard(title: string, summary: ConvertedSummary | null, fallbackBalances: { currency: string; amount: string }[] | undefined, showBreakdown: boolean, toggleBreakdown: () => void)}
  <Card.Root>
    <Card.Header>
      <Card.Description>{title}</Card.Description>
      <Card.Title class="text-2xl">
        {#if !ready}
          <Skeleton class="h-8 w-24" />
        {:else if summary && (summary.converted.length > 0 || summary.unconverted.length === 0)}
          {formatCurrency(summary.total, summary.baseCurrency)}
          {#if settings.debugMode}
            <ConversionDebugDialog {summary} label={title} />
          {/if}
        {:else if fallbackBalances}
          {sumBalances(fallbackBalances)}
        {:else}
          --
        {/if}
      </Card.Title>
      {#if ready && summary}
        {@const count = summary.converted.length + summary.unconverted.length}
        {#if count > 1 || summary.unconverted.length > 0}
          <button onclick={toggleBreakdown}
                  class="text-xs text-muted-foreground hover:underline text-left">
            {count} {count === 1 ? "currency" : "currencies"}{#if summary.unconverted.length > 0}, {summary.unconverted.length} without rate{/if}
          </button>
          {#if showBreakdown}
            <div class="mt-2 text-xs space-y-0.5">
              {#each summary.converted as c}
                <div class="flex justify-between gap-4">
                  <span>{c.currency}</span>
                  <span class="font-mono">{formatCurrency(c.amount, c.currency)}</span>
                </div>
              {/each}
              {#each summary.unconverted as c}
                <div class="flex justify-between gap-4 text-muted-foreground">
                  <span>{c.currency} (no rate)</span>
                  <span class="font-mono">{formatCurrency(c.amount, c.currency)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
    </Card.Header>
  </Card.Root>
{/snippet}

<div class="space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>
      <p class="text-muted-foreground">Overview of your financial data at a glance.</p>
    </div>
    <div class="flex gap-1">
      <Button variant={rangePreset === "mtd" ? "default" : "outline"} size="sm" onclick={() => selectRange("mtd")}>MTD</Button>
      <Button variant={rangePreset === "ytd" ? "default" : "outline"} size="sm" onclick={() => selectRange("ytd")}>YTD</Button>
      <Button variant={rangePreset === "12m" ? "default" : "outline"} size="sm" onclick={() => selectRange("12m")}>12M</Button>
      <Button variant={rangePreset === "all" ? "default" : "outline"} size="sm" onclick={() => selectRange("all")}>All</Button>
    </div>
  </div>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {@render summaryCard(
      "Total Assets",
      assetsSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.assets.totals, hidden) : undefined,
      showAssets,
      () => { showAssets = !showAssets },
    )}
    {@render summaryCard(
      "Total Liabilities",
      liabilitiesSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hidden) : undefined,
      showLiabilities,
      () => { showLiabilities = !showLiabilities },
    )}
    {@render summaryCard(
      `Revenue (${rangePreset.toUpperCase()})`,
      revenueSummary,
      reportStore.incomeStatement ? filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hidden) : undefined,
      showRevenue,
      () => { showRevenue = !showRevenue },
    )}
    {@render summaryCard(
      `Net Income (${rangePreset.toUpperCase()})`,
      netIncomeSummary,
      reportStore.incomeStatement ? filterHiddenBalances(reportStore.incomeStatement.net_income, hidden) : undefined,
      showNetIncome,
      () => { showNetIncome = !showNetIncome },
    )}
  </div>

  <!-- Charts Row -->
  <div class="grid gap-4 lg:grid-cols-3">
    <!-- Net Worth Trend -->
    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>Net Worth</Card.Title>
        <Card.Description>Asset + liability totals in {settings.currency} over time.</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if chartsLoading}
          <Skeleton class="h-48 w-full" />
        {:else if netWorthData.length < 2}
          <p class="text-sm text-muted-foreground py-12 text-center">
            Not enough data for chart. Import transactions spanning multiple months.
          </p>
        {:else}
          <div class="h-48">
            <AreaChart
              data={netWorthData}
              x="date"
              xScale={scaleTime()}
              y="value"
              yScale={scaleLinear()}
              series={[{ key: "value", label: "Net Worth", color: "hsl(var(--chart-1))" }]}
              props={{ area: { opacity: 0.15 } }}
            />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Expense Breakdown -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Expenses</Card.Title>
        <Card.Description>Breakdown by category.</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if chartsLoading}
          <Skeleton class="h-48 w-full" />
        {:else if expenseData.length === 0}
          <p class="text-sm text-muted-foreground py-12 text-center">No expenses in period.</p>
        {:else}
          <div class="h-48">
            <PieChart
              data={expenseData}
              key="category"
              value="amount"
              series={expenseData.map((d) => ({
                key: d.category,
                label: d.category,
                color: d.color,
              }))}
            />
          </div>
          <div class="mt-3 space-y-1">
            {#each expenseData as cat}
              <div class="flex items-center justify-between text-xs">
                <div class="flex items-center gap-1.5">
                  <span class="h-2.5 w-2.5 rounded-full" style="background:{cat.color}"></span>
                  <span>{cat.category}</span>
                </div>
                <span class="font-mono">{formatCurrency(cat.amount, settings.currency)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>

  <!-- Recent Journal Entries -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Recent Journal Entries</Card.Title>
      <Card.Description>Latest transactions.</Card.Description>
    </Card.Header>
    <Card.Content>
      {#if !ready}
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      {:else if filterHiddenEntries(journalStore.entries, hidden).length === 0}
        <p class="text-sm text-muted-foreground py-8 text-center">
          No journal entries yet. Create your first entry to get started.
        </p>
      {:else}
        <div class="space-y-2">
          {#each filterHiddenEntries(journalStore.entries, hidden) as [entry, items]}
            <a href="/journal/{entry.id}" class="flex items-center justify-between rounded-md border p-3 hover:bg-accent transition-colors">
              <div class="flex items-center gap-3">
                <span class="text-sm text-muted-foreground w-24">{entry.date}</span>
                <span class="text-sm font-medium">{entry.description}</span>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full {entry.status === 'confirmed' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : entry.status === 'voided' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'}">
                {entry.status}
              </span>
            </a>
          {/each}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
