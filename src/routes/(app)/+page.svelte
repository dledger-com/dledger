<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import TagDisplay from "$lib/components/TagDisplay.svelte";
  import LinkDisplay from "$lib/components/LinkDisplay.svelte";
  import { parseTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { ReportStore } from "$lib/data/reports.svelte.js";
  import type { JournalEntry, LineItem } from "$lib/types/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import { convertBalances, type ConvertedSummary } from "$lib/utils/currency-convert.js";
  import { computeNetWorthSeries, computeExpenseBreakdown, type NetWorthPoint, type ExpenseCategory } from "$lib/utils/balance-history.js";
  import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
  import { getBackend } from "$lib/backend.js";
  import { countDueTemplates } from "$lib/utils/recurring.js";
  import { toast } from "svelte-sonner";
  import ConversionDebugDialog from "$lib/components/ConversionDebugDialog.svelte";
  import OnboardingWizard from "$lib/components/OnboardingWizard.svelte";
  import OnboardingChecklist from "$lib/components/OnboardingChecklist.svelte";
  import * as m from "$paraglide/messages.js";
  import {
    getCachedRecentEntries, setCachedRecentEntries,
    getCachedSummaries, setCachedSummary,
    getCachedCharts, setCachedCharts,
  } from "$lib/data/dashboard-cache.svelte.js";

  const accountStore = new AccountStore();
  const reportStore = new ReportStore();
  const settings = new SettingsStore();

  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());

  // Dynamically loaded chart libraries (deferred past first paint)
  let AreaChart = $state<typeof import("layerchart").AreaChart | null>(null);
  let PieChart = $state<typeof import("layerchart").PieChart | null>(null);
  let scaleTime = $state<typeof import("d3-scale").scaleTime | null>(null);
  let scaleLinear = $state<typeof import("d3-scale").scaleLinear | null>(null);

  // Read cache at script level so the FIRST render already reflects cached state
  const _cachedRecent = getCachedRecentEntries();
  const _cachedSummaries = getCachedSummaries();
  const _cachedCharts = getCachedCharts();

  let recentLoaded = $state(_cachedRecent.loaded);
  let assetsSummary = $state<ConvertedSummary | null>(_cachedSummaries.assets);
  let liabilitiesSummary = $state<ConvertedSummary | null>(_cachedSummaries.liabilities);
  let revenueSummary = $state<ConvertedSummary | null>(_cachedSummaries.revenue);
  let netIncomeSummary = $state<ConvertedSummary | null>(_cachedSummaries.netIncome);
  let showAssets = $state(false);
  let showLiabilities = $state(false);
  let showRevenue = $state(false);
  let showNetIncome = $state(false);

  // Progress bar — skip if fully cached
  let loadStepsCompleted = $state(0);
  const LOAD_STEPS_TOTAL = 5;
  let loadingActive = $state(
    !(_cachedRecent.loaded && _cachedSummaries.assets && _cachedSummaries.liabilities
      && _cachedSummaries.revenue && _cachedSummaries.netIncome && _cachedCharts.loaded)
  );

  // Recent journal entries (queried directly, not via JournalStore)
  let recentEntries = $state<[JournalEntry, LineItem[]][]>(_cachedRecent.entries);
  let entryTags = $state<Map<string, string[]>>(new Map());
  let entryLinks = $state<Map<string, string[]>>(new Map());

  // Onboarding state
  let sourceCount = $state(0);
  const showOnboardingWizard = $derived(!settings.onboardingCompleted && recentEntries.length === 0 && !loadingActive);
  const showOnboardingChecklist = $derived(!!settings.onboardingCompleted && !settings.onboardingDismissedChecklist);

  async function loadTagsAndLinks(entries: [JournalEntry, LineItem[]][]) {
    const ids = entries.map(([e]) => e.id);
    if (ids.length === 0) return;
    const backend = getBackend();
    try {
      const tagMap = new Map<string, string[]>();
      if (backend.getMetadataBatch) {
        const metas = await backend.getMetadataBatch(ids);
        for (const [id, meta] of metas) tagMap.set(id, parseTags(meta[TAGS_META_KEY]));
      } else {
        const metas = await Promise.all(ids.map((id) => backend.getMetadata(id).catch(() => ({}) as Record<string, string>)));
        ids.forEach((id, i) => tagMap.set(id, parseTags(metas[i][TAGS_META_KEY])));
      }
      entryTags = tagMap;
    } catch { /* ignore */ }
    try {
      if (backend.getEntryLinksBatch) {
        entryLinks = await backend.getEntryLinksBatch(ids);
      } else {
        const links = await Promise.all(ids.map((id) => backend.getEntryLinks(id).catch(() => [] as string[])));
        entryLinks = new Map(ids.map((id, i) => [id, links[i]]));
      }
    } catch { /* ignore */ }
  }

  function debitsByCurrency(items: { amount: string; currency: string }[]): { currency: string; amount: string }[] {
    const map = new Map<string, number>();
    for (const item of items) {
      const n = parseFloat(item.amount);
      if (n > 0) map.set(item.currency, (map.get(item.currency) ?? 0) + n);
    }
    return [...map].map(([currency, amount]) => ({ currency, amount: String(amount) }));
  }

  function formatDebitTotal(items: { amount: string; currency: string }[]): string {
    const byCode = debitsByCurrency(items);
    if (byCode.length === 0) return formatCurrency(0, settings.currency);
    return byCode.map((b) => formatCurrency(b.amount, b.currency)).join(", ");
  }

  // Charts
  let netWorthData = $state<NetWorthPoint[]>(_cachedCharts.netWorth);
  let expenseData = $state<ExpenseCategory[]>(_cachedCharts.expenses);
  let chartsLoading = $state(!_cachedCharts.loaded);

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
    if (balances.length === 0) return formatCurrency(0, settings.currency);
    return balances
      .map((b) => formatCurrency(b.amount, b.currency))
      .join(", ");
  }

  async function loadCharts(sharedCache?: ExchangeRateCache, signal?: AbortSignal) {
    chartsLoading = true;
    try {
      const from = rangeFromDate();
      const to = today();
      const base = settings.currency;

      const backend = getBackend();
      const cache = sharedCache ?? new ExchangeRateCache(backend);
      const [nw, exp] = await Promise.all([
        computeNetWorthSeries(backend, from, to, base, cache, signal),
        computeExpenseBreakdown(backend, from, to, base, 6, reportStore.incomeStatement ?? undefined, cache, signal),
      ]);
      if (signal?.aborted) return;
      netWorthData = nw;
      expenseData = exp;
      setCachedCharts(nw, exp);
    } catch (e) {
      if (signal?.aborted) return;
      console.error("Charts failed:", e);
    } finally {
      chartsLoading = false;
      loadStepsCompleted++;
      loadingActive = false;
    }
  }

  let loadController: AbortController | undefined;

  onMount(async () => {
    loadController = new AbortController();
    const signal = loadController.signal;

    // 1. Dynamic import of heavy chart libraries (truly async, non-blocking)
    Promise.all([import("layerchart"), import("d3-scale")]).then(([lc, d3]) => {
      AreaChart = lc.AreaChart;
      PieChart = lc.PieChart;
      scaleTime = d3.scaleTime;
      scaleLinear = d3.scaleLinear;
    });

    // 1b. Load source count for onboarding checklist
    try {
      const backend = getBackend();
      const [eth, btc, sol, hl, sui, apt, cex] = await Promise.all([
        backend.listEtherscanAccounts(), backend.listBitcoinAccounts(),
        backend.listSolanaAccounts(), backend.listHyperliquidAccounts(),
        backend.listSuiAccounts(), backend.listAptosAccounts(),
        backend.listExchangeAccounts(),
      ]);
      sourceCount = eth.length + btc.length + sol.length + hl.length + sui.length + apt.length + cex.length;
    } catch { /* non-critical */ }

    // 2. Yield to guarantee browser paints skeleton/cached state before heavy queries.
    //    rAF enters the rendering pipeline → browser paints → setTimeout fires in next macrotask.
    await new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
    if (signal.aborted) return;

    // 3. Run ALL data queries after paint
    const date = today();
    const base = settings.currency;
    const hiddenSet = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();
    const sharedCache = getOrCreateRateCache();

    // Stream 1: Recent entries (independent, fast single query)
    getBackend()
      .queryJournalEntries({ limit: 25, order_by: "date", order_direction: "desc" })
      .then((entries) => {
        if (signal.aborted) return;
        const filtered = filterHiddenEntries(entries, hidden).slice(0, 10);
        recentEntries = filtered;
        recentLoaded = true;
        loadStepsCompleted++;
        setCachedRecentEntries(filtered);
        loadTagsAndLinks(filtered);
      })
      .catch((e) => { if (!signal.aborted) console.error("Recent entries failed:", e); });

    // Stream 2: Account store (independent, for name lookups)
    accountStore.load();

    // Stream 3: Balance sheet → assets/liabilities cards (independent chain)
    const conversionPromises: Promise<void>[] = [];
    const bsPromise = reportStore.loadBalanceSheet(date, signal).then(() => {
      if (signal.aborted) return;
      loadStepsCompleted++;
      if (reportStore.balanceSheet) {
        conversionPromises.push(
          convertBalances(
            filterHiddenBalances(reportStore.balanceSheet.assets.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { assetsSummary = s; setCachedSummary("assets", s); } }).catch(() => {}),
          convertBalances(
            filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { liabilitiesSummary = s; setCachedSummary("liabilities", s); } }).catch(() => {}),
        );
      }
    });

    // Stream 4: Income statement → revenue/net income cards (independent chain)
    const isPromise = reportStore.loadIncomeStatement(rangeFromDate(), date, signal).then(() => {
      if (signal.aborted) return;
      loadStepsCompleted++;
      if (reportStore.incomeStatement) {
        conversionPromises.push(
          convertBalances(
            filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { revenueSummary = s; setCachedSummary("revenue", s); } }).catch(() => {}),
          convertBalances(
            filterHiddenBalances(reportStore.incomeStatement.net_income, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { netIncomeSummary = s; setCachedSummary("netIncome", s); } }).catch(() => {}),
        );
      }
    });

    // Stream 5: Charts (need both reports, but NOT conversions)
    Promise.all([bsPromise, isPromise])
      .then(() => {
        if (signal.aborted) return;
        // Track conversion completions
        Promise.allSettled(conversionPromises).then(() => { if (!signal.aborted) loadStepsCompleted++; });
        return loadCharts(sharedCache, signal);
      })
      .catch((e) => { if (!signal.aborted) console.error("Charts failed:", e); });

    // Stream 6: Recurring templates toast (independent)
    countDueTemplates(getBackend())
      .then((count) => {
        if (signal.aborted) return;
        if (count > 0) {
          toast.info(count === 1 ? m.dashboard_recurring_due_one() : m.dashboard_recurring_due_other({ count: String(count) }), {
            action: { label: m.btn_generate(), onClick: () => { window.location.href = "/journal/recurring"; } },
          });
        }
      })
      .catch(() => {});
  });

  // ── Invalidation subscriptions ──────────────────────────────────
  async function refreshRecentEntries() {
    try {
      const entries = await getBackend().queryJournalEntries({ limit: 25, order_by: "date", order_direction: "desc" });
      const filtered = filterHiddenEntries(entries, hidden).slice(0, 10);
      recentEntries = filtered;
      setCachedRecentEntries(filtered);
      loadTagsAndLinks(filtered);
    } catch (e) {
      console.error("Failed to refresh recent entries:", e);
    }
  }

  function refreshReports() {
    // Cancel any in-flight load
    loadController?.abort();
    loadController = new AbortController();
    const signal = loadController.signal;

    loadStepsCompleted = 0;
    loadingActive = true;

    const sharedCache = getOrCreateRateCache();
    const date = today();
    const base = settings.currency;
    const hiddenSet = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();

    // Recent entries count as already done during refresh (step 1)
    loadStepsCompleted++;

    const refreshConversionPromises: Promise<void>[] = [];
    const bsPromise = reportStore.loadBalanceSheet(date, signal).then(() => {
      if (signal.aborted) return;
      loadStepsCompleted++;
      if (reportStore.balanceSheet) {
        refreshConversionPromises.push(
          convertBalances(
            filterHiddenBalances(reportStore.balanceSheet.assets.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { assetsSummary = s; setCachedSummary("assets", s); } }).catch(() => {}),
          convertBalances(
            filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { liabilitiesSummary = s; setCachedSummary("liabilities", s); } }).catch(() => {}),
        );
      }
    });

    const isPromise = reportStore.loadIncomeStatement(rangeFromDate(), date, signal).then(() => {
      if (signal.aborted) return;
      loadStepsCompleted++;
      if (reportStore.incomeStatement) {
        refreshConversionPromises.push(
          convertBalances(
            filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { revenueSummary = s; setCachedSummary("revenue", s); } }).catch(() => {}),
          convertBalances(
            filterHiddenBalances(reportStore.incomeStatement.net_income, hiddenSet),
            base, date, sharedCache, signal,
          ).then((s) => { if (!signal.aborted) { netIncomeSummary = s; setCachedSummary("netIncome", s); } }).catch(() => {}),
        );
      }
    });

    Promise.all([bsPromise, isPromise])
      .then(() => {
        if (signal.aborted) return;
        Promise.allSettled(refreshConversionPromises).then(() => { if (!signal.aborted) loadStepsCompleted++; });
        return loadCharts(sharedCache, signal);
      })
      .catch((e) => { if (!signal.aborted) console.error("Failed to refresh reports:", e); });
  }

  const unsubJournal = onInvalidate("journal", refreshRecentEntries);
  const unsubAccounts = onInvalidate("accounts", () => { accountStore.load(); });
  const unsubReports = onInvalidate("reports", refreshReports);

  onDestroy(() => {
    loadController?.abort();
    unsubJournal();
    unsubAccounts();
    unsubReports();
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
        {#if fallbackBalances === undefined}
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
      {#if summary}
        {@const count = summary.converted.length + summary.unconverted.length}
        {#if count > 1 || summary.unconverted.length > 0}
          <button onclick={toggleBreakdown}
                  class="text-xs text-muted-foreground hover:underline text-left">
            {count === 1 ? m.dashboard_currencies_one() : m.dashboard_currencies_other({ count: String(count) })}{#if summary.unconverted.length > 0}{m.dashboard_without_rate({ count: String(summary.unconverted.length) })}{/if}
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
                  <span>{c.currency} ({m.dashboard_no_rate()})</span>
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

{#if showOnboardingWizard}
  <OnboardingWizard onComplete={() => settings.update({ onboardingCompleted: true })} />
{/if}

<div class="space-y-6">
  {#if showOnboardingChecklist}
    <OnboardingChecklist
      hasBaseCurrency={!!settings.currency}
      hasAccounts={accountStore.accounts.length > 0}
      hasSources={sourceCount > 0}
      hasTransactions={recentEntries.length > 0}
      onDismiss={() => settings.update({ onboardingDismissedChecklist: true })}
    />
  {/if}

  <div class="flex justify-end">
    <div class="flex gap-1">
      <Button variant={rangePreset === "mtd" ? "default" : "outline"} size="sm" onclick={() => selectRange("mtd")}>MTD</Button>
      <Button variant={rangePreset === "ytd" ? "default" : "outline"} size="sm" onclick={() => selectRange("ytd")}>YTD</Button>
      <Button variant={rangePreset === "12m" ? "default" : "outline"} size="sm" onclick={() => selectRange("12m")}>12M</Button>
      <Button variant={rangePreset === "all" ? "default" : "outline"} size="sm" onclick={() => selectRange("all")}>{m.range_all()}</Button>
    </div>
  </div>

  {#if loadingActive && loadStepsCompleted < LOAD_STEPS_TOTAL}
    <div class="h-1 w-full bg-muted overflow-hidden">
      <div
        class="h-full bg-primary transition-[width] duration-150 ease-linear"
        style="width: {(loadStepsCompleted / LOAD_STEPS_TOTAL) * 100}%"
      ></div>
    </div>
  {/if}

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {@render summaryCard(
      m.report_total_assets(),
      assetsSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.assets.totals, hidden) : undefined,
      showAssets,
      () => { showAssets = !showAssets },
    )}
    {@render summaryCard(
      m.report_total_liabilities(),
      liabilitiesSummary,
      reportStore.balanceSheet ? filterHiddenBalances(reportStore.balanceSheet.liabilities.totals, hidden) : undefined,
      showLiabilities,
      () => { showLiabilities = !showLiabilities },
    )}
    {@render summaryCard(
      m.dashboard_revenue_period({ period: rangePreset.toUpperCase() }),
      revenueSummary,
      reportStore.incomeStatement ? filterHiddenBalances(reportStore.incomeStatement.revenue.totals, hidden) : undefined,
      showRevenue,
      () => { showRevenue = !showRevenue },
    )}
    {@render summaryCard(
      m.dashboard_net_income_period({ period: rangePreset.toUpperCase() }),
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
        <Card.Title>{m.chart_net_worth()}</Card.Title>
        <Card.Description>{m.chart_net_worth_desc({ currency: settings.currency })}</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if chartsLoading || !AreaChart || !scaleTime || !scaleLinear}
          <Skeleton class="h-48 w-full" />
        {:else if netWorthData.length < 2}
          <p class="text-sm text-muted-foreground py-12 text-center">
            {m.empty_not_enough_chart_data()}
          </p>
        {:else}
          <div class="h-48">
            <AreaChart
              data={netWorthData}
              x="date"
              xScale={scaleTime()}
              y="value"
              yScale={scaleLinear()}
              series={[{ key: "value", label: m.chart_net_worth(), color: "hsl(var(--chart-1))" }]}
              props={{ area: { opacity: 0.15 } }}
            />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Expense Breakdown -->
    <Card.Root>
      <Card.Header>
        <Card.Title>{m.chart_expenses()}</Card.Title>
        <Card.Description>{m.chart_expenses_desc()}</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if chartsLoading || !PieChart}
          <Skeleton class="h-48 w-full" />
        {:else if expenseData.length === 0}
          <p class="text-sm text-muted-foreground py-12 text-center">{m.empty_no_expenses()}</p>
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
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-semibold tracking-tight">{m.section_recent_entries()}</h2>
    <Button variant="link" size="sm" href="/journal">{m.btn_view_all()}</Button>
  </div>
  {#if !recentLoaded}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if recentEntries.length === 0}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_journal_entries()}
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-x-0 rounded-none shadow-none py-0">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-0 hidden sm:table-cell">{m.label_date()}</Table.Head>
            <Table.Head>{m.label_description()}</Table.Head>
            <Table.Head class="text-right hidden sm:table-cell">{m.label_amount()}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each recentEntries as [entry, items]}
            <Table.Row class="flex flex-wrap sm:table-row {entry.status === 'voided' ? 'line-through opacity-50' : ''}">
              <Table.Cell class="text-muted-foreground order-1 text-xs sm:text-sm w-auto shrink-0 py-2 pr-2 sm:p-2">{entry.date}</Table.Cell>
              <Table.Cell class="order-3 w-full sm:w-auto sm:max-w-[300px] whitespace-normal sm:whitespace-nowrap pt-0 pb-2 sm:p-2">
                <div class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0">
                  <a href="/journal/{entry.id}" class="font-medium hover:underline overflow-clip text-ellipsis whitespace-nowrap" title={entry.description}>{entry.description}</a>
                  {#if entryTags.get(entry.id)?.length}
                    <TagDisplay tags={entryTags.get(entry.id)!} class="shrink-0" />
                  {/if}
                  {#if entryLinks.get(entry.id)?.length}
                    <LinkDisplay links={entryLinks.get(entry.id)!} class="shrink-0" />
                  {/if}
                </div>
              </Table.Cell>
              <Table.Cell class="text-right font-mono order-2 ml-auto py-2 pl-2 sm:p-2">
                {formatDebitTotal(items)}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {/if}
</div>
