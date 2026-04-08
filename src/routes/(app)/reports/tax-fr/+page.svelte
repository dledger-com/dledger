<svelte:head><title>French Tax Report · dLedger</title></svelte:head>

<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import Decimal from "decimal.js-light";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import {
    computeFrenchTaxReport,
    resolvePriorAcquisitionCost,
    type FrenchTaxReport,
    type PersistedFrenchTaxReport,
  } from "$lib/utils/french-tax.js";
  import { exportFrenchTaxCsv, exportForm3916bisCsv } from "$lib/utils/csv-export.js";
  import {
    findMissingRates,
    resolveDpriceAssets,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import TaxSummaryBanner from "./TaxSummaryBanner.svelte";
  import OverviewTab from "./OverviewTab.svelte";
  import Form2086Tab from "./Form2086Tab.svelte";
  import Form2042CTab from "./Form2042CTab.svelte";
  import Form3916bisTab from "./Form3916bisTab.svelte";
  import ChecklistTab from "./ChecklistTab.svelte";
  import type { ExchangeAccount } from "$lib/cex/types.js";
  import { requiresDeclaration } from "$lib/cex/institution-registry.js";
  import { onMount, onDestroy } from "svelte";
  import * as m from "$paraglide/messages.js";

  const settings = new SettingsStore();

  // Year chips: 2019 to current year - 1
  const currentYear = new Date().getFullYear();
  const availableYears = Array.from({ length: currentYear - 2019 }, (_, i) => currentYear - 1 - i);

  let taxYear = $state(currentYear - 1);
  let loading = $state(false);
  let report = $state<FrenchTaxReport | null>(null);
  let error = $state<string | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);

  // Chain data: persisted years → final acquisition cost
  let chainData = $state<Map<number, string>>(new Map());
  let savedReport = $state<PersistedFrenchTaxReport | null>(null);
  let checklist = $state<Record<string, boolean>>({});
  let initialAcquisitionCost = $state(settings.settings.frenchTax?.initialAcquisitionCost ?? "0");
  let overridePriorCost = $state(false);
  let overrideValue = $state("");
  let staleWarning = $state<string | null>(null);

  // Exchange accounts for 3916-bis
  let allExchangeAccounts = $state<ExchangeAccount[]>([]);

  /** Filter to accounts active during the tax year (open/close range overlaps) */
  const exchangeAccounts = $derived(
    allExchangeAccounts.filter((a) => {
      const openYear = a.opened_at ? parseInt(a.opened_at.slice(0, 4), 10) : null;
      const closeYear = a.closed_at ? parseInt(a.closed_at.slice(0, 4), 10) : null;
      if (openYear !== null && openYear > taxYear) return false;
      if (closeYear !== null && closeYear < taxYear) return false;
      return true;
    }),
  );

  const foreignAccountCount = $derived(
    exchangeAccounts.filter((a) => requiresDeclaration(a.exchange, taxYear)).length,
  );

  // Resolved prior cost for current year
  const resolved = $derived(resolvePriorAcquisitionCost(taxYear, initialAcquisitionCost, chainData));
  const effectivePriorCost = $derived(overridePriorCost ? overrideValue : resolved.value);

  const hasSavedReport = $derived(chainData.has(taxYear));

  // Detect stale earliest report when initialAcquisitionCost changes.
  // When the earliest persisted year uses 'initial' source (no prior year in chain),
  // compare what the report was generated with vs the current setting.
  const staleInitialCostBanner = $derived.by(() => {
    if (!savedReport || !chainData.size) return null;
    const years = [...chainData.keys()].sort((a, b) => a - b);
    const earliestYear = years[0];
    // Only relevant when viewing the earliest year and it uses initial source
    if (taxYear !== earliestYear) return null;
    if (chainData.has(earliestYear - 1)) return null; // chained, not initial
    // Compare: expected A before first event = initialAcquisitionCost + pre-year acquisitions
    const currentInitial = initialAcquisitionCost || '0';
    const rpt = savedReport.report;
    const expectedStartingA = new Decimal(currentInitial).plus(new Decimal(rpt.preYearAcquisitionTotal));
    // Recover actual starting A from report data
    let actualStartingA: Decimal;
    if (rpt.dispositions.length > 0) {
      actualStartingA = new Decimal(rpt.dispositions[0].acquisitionCostBefore);
    } else {
      // No dispositions recorded — finalA = startingA + in-year acquisitions
      const inYearAcqTotal = rpt.acquisitions.reduce(
        (sum, a) => sum.plus(new Decimal(a.fiatSpent)), new Decimal(0),
      );
      actualStartingA = new Decimal(rpt.finalAcquisitionCost).minus(inYearAcqTotal);
    }
    if (!expectedStartingA.eq(actualStartingA)) {
      return `The initial acquisition cost has changed since the ${earliestYear} report was generated — consider regenerating.`;
    }
    return null;
  });

  // Chain visualization
  const chainSummary = $derived.by(() => {
    const years = [...chainData.keys()].sort((a, b) => a - b);
    const parts: { label: string; value: string }[] = [];
    if (initialAcquisitionCost && initialAcquisitionCost !== "0") {
      parts.push({ label: m.report_pre_dledger(), value: formatCurrency(initialAcquisitionCost, "EUR") });
    }
    for (const y of years) {
      parts.push({ label: m.report_after_year({ year: String(y) }), value: formatCurrency(chainData.get(y)!, "EUR") });
    }
    return parts;
  });

  // Multi-year gap detection
  const missingYears = $derived.by(() => {
    if (taxYear <= 2019) return [];
    const missing: number[] = [];
    for (let y = 2019; y < taxYear; y++) {
      if (!chainData.has(y)) missing.push(y);
    }
    // Only warn if there are some reports but gaps exist
    if (chainData.size === 0) return [];
    return missing;
  });

  let generatingAll = $state(false);

  async function loadChainData() {
    const backend = getBackend();
    const years = await backend.listFrenchTaxReportYears();
    const map = new Map<number, string>();
    for (const y of years) {
      const persisted = await backend.getFrenchTaxReport(y);
      if (persisted) {
        map.set(y, persisted.finalAcquisitionCost);
      }
    }
    chainData = map;
  }

  async function loadSavedReport() {
    savedReport = await getBackend().getFrenchTaxReport(taxYear);
    if (savedReport) {
      report = savedReport.report;
      checklist = savedReport.checklist;
    } else {
      report = null;
      checklist = {};
    }
    missingRateRequests = [];
    error = null;
    staleWarning = null;
    overridePriorCost = false;
    overrideValue = "";
  }

  async function loadExchangeAccounts() {
    try {
      allExchangeAccounts = await getBackend().listExchangeAccounts();
    } catch {
      allExchangeAccounts = [];
    }
  }

  async function generate() {
    loading = true;
    error = null;
    report = null;
    missingRateRequests = [];
    staleWarning = null;

    // Save initial acquisition cost to settings (sync, fine outside task)
    if (initialAcquisitionCost !== (settings.settings.frenchTax?.initialAcquisitionCost ?? "0")) {
      settings.update({
        frenchTax: {
          ...settings.settings.frenchTax,
          initialAcquisitionCost,
        },
      });
    }

    const capturedYear = taxYear;
    const capturedPriorCost = effectivePriorCost;
    const capturedPriorSource = overridePriorCost ? 'initial' as const : resolved.source;
    const capturedFiatCurrencies = settings.settings.frenchTax?.fiatCurrencies;
    const capturedInitialCost = initialAcquisitionCost;

    return new Promise<void>((resolve) => {
      const id = taskQueue.enqueue({
        key: `report:tax-fr:${capturedYear}`,
        label: m.report_french_tax(),
        description: `Year ${capturedYear}`,
        run: async () => {
          try {
            report = await computeFrenchTaxReport(getBackend(), {
              taxYear: capturedYear,
              priorAcquisitionCost: capturedPriorCost,
              priorCostSource: capturedPriorSource,
              fiatCurrencies: capturedFiatCurrencies,
            });

            // Auto-save to DB (preserve existing checklist on regenerate)
            await getBackend().saveFrenchTaxReport(capturedYear, report, checklist);
            await loadChainData();
            savedReport = await getBackend().getFrenchTaxReport(capturedYear);

            // Check for stale downstream reports
            const nextYearReport = await getBackend().getFrenchTaxReport(capturedYear + 1);
            if (nextYearReport) {
              const nextResolved = resolvePriorAcquisitionCost(capturedYear + 1, capturedInitialCost, chainData);
              if (nextResolved.source === "chained" && nextResolved.value !== nextYearReport.report.dispositions?.[0]?.acquisitionCostBefore) {
                staleWarning = `The ${capturedYear + 1} report may be stale — its prior acquisition cost differs from the new ${capturedYear} final value. Consider regenerating it.`;
              }
            }

            if (report.missingCurrencyDates.length > 0) {
              const currencies = [...new Set(report.missingCurrencyDates.map((d) => d.currency))];
              const dpriceAssets = await resolveDpriceAssets(settings.buildRateConfig(), currencies);
              missingRateRequests = await findMissingRates(
                getBackend(),
                "EUR",
                report.missingCurrencyDates,
                dpriceAssets,
                undefined,
                settings.buildRateConfig().disabledSources,
              );
            }
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          } finally {
            loading = false;
            resolve();
          }
          return { summary: `French tax report for ${capturedYear} generated` };
        },
      });
      if (id === null) {
        loading = false;
        resolve();
      }
    });
  }

  async function handleChecklistChange(newChecklist: Record<string, boolean>) {
    checklist = newChecklist;
    if (report) {
      await getBackend().saveFrenchTaxReport(taxYear, report, newChecklist);
    }
  }

  async function deleteReport() {
    // Check if downstream reports depend on this
    const nextYearFinal = chainData.get(taxYear + 1);
    if (nextYearFinal !== undefined) {
      if (!confirm(m.report_delete_confirm_chain({ year: String(taxYear + 1) }))) return;
    }
    await getBackend().deleteFrenchTaxReport(taxYear);
    await loadChainData();
    savedReport = null;
    report = null;
    checklist = {};
    staleWarning = null;
  }

  async function generateAllMissing() {
    generatingAll = true;
    const years = [...missingYears];
    const capturedFiatCurrencies = settings.settings.frenchTax?.fiatCurrencies;
    const capturedInitialCost = initialAcquisitionCost;

    return new Promise<void>((resolve) => {
      taskQueue.enqueue({
        key: `report:tax-fr:all-missing`,
        label: m.report_french_tax_plural(),
        description: `Generating ${years.length} missing years`,
        run: async (ctx) => {
          try {
            for (const year of years) {
              if (ctx.signal.aborted) break;
              const r = resolvePriorAcquisitionCost(year, capturedInitialCost, chainData);
              const rpt = await computeFrenchTaxReport(getBackend(), {
                taxYear: year,
                priorAcquisitionCost: r.value,
                priorCostSource: r.source,
                fiatCurrencies: capturedFiatCurrencies,
              });
              await getBackend().saveFrenchTaxReport(year, rpt);
              await loadChainData();
            }
            await loadSavedReport();
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          } finally {
            generatingAll = false;
            resolve();
          }
          return { summary: `Generated ${years.length} missing reports` };
        },
      });
    });
  }

  let mounted = $state(false);

  // Load data on mount
  onMount(() => {
    loadChainData();
    loadSavedReport();
    loadExchangeAccounts();
    mounted = true;
  });

  onDestroy(() => {
    clearTopBarActions();
  });

  // React to year changes after initial mount
  let prevYear = $state(taxYear);
  $effect(() => {
    if (mounted && taxYear !== prevYear) {
      prevYear = taxYear;
      loadSavedReport();
    }
  });

  // TopBar actions
  $effect(() => {
    const _report = report;
    const _hasSaved = hasSavedReport;
    const _loading = loading;

    const actions: import("$lib/data/page-actions.svelte.js").PageAction[] = [
      {
        type: "button",
        label: _loading ? m.state_generating() : _hasSaved ? m.report_regenerate() : m.btn_generate(),
        onclick: generate,
        disabled: _loading,
      },
    ];

    if (_report || _hasSaved) {
      actions.push({
        type: "menu",
        items: [
          ...(_report
            ? [
                { label: m.report_export_form_2086(), onclick: () => exportFrenchTaxCsv(_report) },
                ...(exchangeAccounts.length > 0
                  ? [{ label: m.report_export_3916bis(), onclick: () => exportForm3916bisCsv(exchangeAccounts, taxYear) }]
                  : []),
                { separator: true, label: "" },
              ]
            : []),
          ...(_hasSaved
            ? [{ label: m.report_delete(), onclick: deleteReport }]
            : []),
        ],
      });
    }

    setTopBarActions(actions);
  });
</script>

<div class="space-y-6">
  <!-- Chain Visualization -->
  {#if chainSummary.length > 0}
    <div class="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
      {#each chainSummary as part, i}
        {#if i > 0}<span class="text-muted-foreground/50">&rarr;</span>{/if}
        <span class="font-mono"><span class="text-xs opacity-60">{part.label}:</span> {part.value}</span>
      {/each}
    </div>
  {/if}

  <!-- Stale initial cost warning -->
  {#if staleInitialCostBanner}
    <div class="flex items-center gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
      <AlertTriangle class="h-4 w-4 shrink-0" />
      <span>{staleInitialCostBanner}</span>
    </div>
  {/if}

  <!-- Multi-year gap warning -->
  {#if missingYears.length > 0}
    <div class="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
      <AlertTriangle class="h-4 w-4 shrink-0 mt-0.5" />
      <div class="flex-1">
        <p>{m.report_missing_years({ years: missingYears.join(", ") })}</p>
        <Button
          variant="outline"
          size="sm"
          class="mt-2"
          onclick={generateAllMissing}
          disabled={generatingAll}
        >
          {generatingAll ? m.state_generating() : m.report_generate_all_missing({ count: String(missingYears.length) })}
        </Button>
      </div>
    </div>
  {/if}

  <!-- Parameters Card -->
  <Card.Root>
    <Card.Header class="pb-3">
      <Card.Title class="text-base">{m.report_parameters()}</Card.Title>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- Year Chips -->
      <div class="space-y-1">
        <label class="text-sm font-medium">{m.report_tax_year()}</label>
        <div class="flex flex-wrap gap-1.5">
          {#each availableYears as year}
            <button
              class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors
                {year === taxYear
                  ? 'bg-primary text-primary-foreground border-primary'
                  : chainData.has(year)
                    ? 'bg-secondary text-secondary-foreground border-secondary hover:bg-secondary/80'
                    : 'border-input bg-background hover:bg-accent hover:text-accent-foreground'
                }"
              onclick={() => { taxYear = year; }}
            >
              {year}
              {#if chainData.has(year)}
                <span class="ml-1 text-[10px] opacity-60">&#10003;</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <!-- Prior Acquisition Cost -->
      <div class="space-y-2">
        {#if resolved.source === "chained"}
          <div class="flex items-center gap-2 text-sm flex-wrap">
            <span class="font-medium">{m.report_prior_acquisition_cost()}</span>
            <span class="font-mono">{formatCurrency(resolved.value, "EUR")}</span>
            <Badge variant="secondary">{m.report_from_year_report({ year: String(resolved.sourceYear) })}</Badge>
            <Button variant="ghost" size="sm" class="h-6 text-xs" onclick={() => { overridePriorCost = !overridePriorCost; overrideValue = resolved.value; }}>
              {overridePriorCost ? m.report_use_chained() : m.report_override()}
            </Button>
          </div>
          {#if overridePriorCost}
            <Input type="text" bind:value={overrideValue} class="w-40" placeholder="0.00" />
          {/if}
        {:else}
          <div class="space-y-1">
            <label for="initial-a" class="text-sm font-medium">{m.report_initial_acquisition_cost()}</label>
            <Input id="initial-a" type="text" bind:value={initialAcquisitionCost} class="w-40" placeholder="0.00" />
            <p class="text-xs text-muted-foreground">{m.report_initial_cost_desc()}</p>
          </div>
        {/if}

        <!-- Gap warning -->
        {#if resolved.source !== "chained" && taxYear > 2019}
          {@const prevYearVal = taxYear - 1}
          {#if !chainData.has(prevYearVal) && chainData.size > 0}
            <div class="flex items-center gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
              <AlertTriangle class="h-4 w-4 shrink-0" />
              <span>{m.report_no_saved_report_for({ year: String(prevYearVal) })}</span>
            </div>
          {/if}
        {/if}
      </div>

      {#if savedReport}
        <p class="text-xs text-muted-foreground">
          {m.report_last_generated({ date: new Date(savedReport.generatedAt).toLocaleString() })}
        </p>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- Stale Warning -->
  {#if staleWarning}
    <div class="flex items-center gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
      <AlertTriangle class="h-4 w-4 shrink-0" />
      <span>{staleWarning}</span>
    </div>
  {/if}

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
  {:else if report}
    <!-- Summary Banner -->
    <TaxSummaryBanner {report} {taxYear} />

    <MissingRateBanner requests={missingRateRequests} onFetched={generate} baseCurrency="EUR" />

    <!-- Tabs -->
    <Tabs.Root value="overview">
      <Tabs.List class="overflow-x-auto">
        <Tabs.Trigger value="overview">{m.report_overview()}</Tabs.Trigger>
        <Tabs.Trigger value="form2086">{m.report_form_2086()}</Tabs.Trigger>
        <Tabs.Trigger value="form2042c">{m.report_form_2042c()}</Tabs.Trigger>
        <Tabs.Trigger value="form3916bis">{m.report_form_3916bis()}</Tabs.Trigger>
        <Tabs.Trigger value="checklist">{m.report_checklist()}</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="overview" class="mt-4">
        <OverviewTab {report} {taxYear} {foreignAccountCount} debugMode={settings.debugMode} />
      </Tabs.Content>

      <Tabs.Content value="form2086" class="mt-4">
        <Form2086Tab {report} />
      </Tabs.Content>

      <Tabs.Content value="form2042c" class="mt-4">
        <Form2042CTab {report} {taxYear} />
      </Tabs.Content>

      <Tabs.Content value="form3916bis" class="mt-4">
        <Form3916bisTab {exchangeAccounts} {taxYear} />
      </Tabs.Content>

      <Tabs.Content value="checklist" class="mt-4">
        <ChecklistTab {report} {taxYear} {hasSavedReport} {foreignAccountCount} {checklist} onChecklistChange={handleChecklistChange} />
      </Tabs.Content>
    </Tabs.Root>
  {:else}
    <!-- Empty state: no report generated -->
    <Card.Root>
      <Card.Content class="py-8 text-center space-y-3">
        <p class="text-lg font-semibold">{m.report_ready_to_generate({ year: String(taxYear) })}</p>
        <p class="text-sm text-muted-foreground max-w-lg mx-auto">
          {m.report_compute_description()}
        </p>
        {#if resolved.source === "chained"}
          <p class="text-sm text-green-700 dark:text-green-300">
            {m.report_prior_year_available({ cost: formatCurrency(resolved.value, "EUR") })}
          </p>
        {:else if initialAcquisitionCost && initialAcquisitionCost !== "0"}
          <p class="text-sm text-muted-foreground">
            {m.report_using_initial_cost({ cost: formatCurrency(initialAcquisitionCost, "EUR") })}
          </p>
        {:else}
          <div class="flex items-center justify-center gap-1.5 text-sm text-yellow-700 dark:text-yellow-300">
            <AlertTriangle class="h-3.5 w-3.5" />
            <span>{m.report_no_prior_year()}</span>
          </div>
        {/if}
        <Button onclick={generate} disabled={loading} class="mt-2">
          {m.report_generate_report()}
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
