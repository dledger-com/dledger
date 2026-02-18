<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { convertBalances, type ConvertedSummary } from "$lib/utils/currency-convert.js";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();
  const reportStore = new ReportStore();
  const settings = new SettingsStore();

  let ready = $state(false);
  let assetsSummary = $state<ConvertedSummary | null>(null);
  let liabilitiesSummary = $state<ConvertedSummary | null>(null);
  let revenueSummary = $state<ConvertedSummary | null>(null);
  let netIncomeSummary = $state<ConvertedSummary | null>(null);
  let showAssets = $state(false);
  let showLiabilities = $state(false);
  let showRevenue = $state(false);
  let showNetIncome = $state(false);

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function firstOfYear(): string {
    return `${new Date().getFullYear()}-01-01`;
  }

  function sumBalances(balances: { currency: string; amount: string }[]): string {
    if (balances.length === 0) return formatCurrency(0);
    return balances
      .map((b) => formatCurrency(b.amount, b.currency))
      .join(", ");
  }

  onMount(async () => {
    try {
      await Promise.all([
        accountStore.load(),
        journalStore.load({ limit: 10 }),
        reportStore.loadBalanceSheet(today()),
        reportStore.loadIncomeStatement(firstOfYear(), today()),
      ]);
    } catch (e) {
      console.error("Dashboard load failed:", e);
    } finally {
      ready = true;
    }

    // Convert balances to base currency (non-blocking)
    const date = today();
    const base = settings.currency;
    const hidden = settings.hiddenCurrencySet;

    try {
      const promises: Promise<void>[] = [];
      if (reportStore.balanceSheet) {
        promises.push(
          convertBalances(filterHiddenBalances(reportStore.balanceSheet.assets.totals, hidden), base, date)
            .then(s => { assetsSummary = s; }),
          convertBalances(filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hidden), base, date)
            .then(s => { liabilitiesSummary = s; }),
        );
      }
      if (reportStore.incomeStatement) {
        promises.push(
          convertBalances(filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hidden), base, date)
            .then(s => { revenueSummary = s; }),
          convertBalances(filterHiddenBalances(reportStore.incomeStatement.net_income, hidden), base, date)
            .then(s => { netIncomeSummary = s; }),
        );
      }
      await Promise.all(promises);
    } catch (e) {
      console.error("Currency conversion failed:", e);
    }
  });
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
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>
    <p class="text-muted-foreground">Overview of your financial data at a glance.</p>
  </div>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {@render summaryCard(
      "Total Assets",
      assetsSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.assets.totals, settings.hiddenCurrencySet) : undefined,
      showAssets,
      () => { showAssets = !showAssets },
    )}
    {@render summaryCard(
      "Total Liabilities",
      liabilitiesSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, settings.hiddenCurrencySet) : undefined,
      showLiabilities,
      () => { showLiabilities = !showLiabilities },
    )}
    {@render summaryCard(
      "Revenue (YTD)",
      revenueSummary,
      reportStore.incomeStatement ? filterHiddenBalances(reportStore.incomeStatement.revenue.totals, settings.hiddenCurrencySet) : undefined,
      showRevenue,
      () => { showRevenue = !showRevenue },
    )}
    {@render summaryCard(
      "Net Income (YTD)",
      netIncomeSummary,
      reportStore.incomeStatement ? filterHiddenBalances(reportStore.incomeStatement.net_income, settings.hiddenCurrencySet) : undefined,
      showNetIncome,
      () => { showNetIncome = !showNetIncome },
    )}
  </div>

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
      {:else if filterHiddenEntries(journalStore.entries, settings.hiddenCurrencySet).length === 0}
        <p class="text-sm text-muted-foreground py-8 text-center">
          No journal entries yet. Create your first entry to get started.
        </p>
      {:else}
        <div class="space-y-2">
          {#each filterHiddenEntries(journalStore.entries, settings.hiddenCurrencySet) as [entry, items]}
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
