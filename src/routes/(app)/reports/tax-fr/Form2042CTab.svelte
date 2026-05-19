<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency, formatNumber, parseLocaleNumber } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import { recommendRegime } from "$lib/utils/french-bareme.js";
  import { estimateOtherTaxableIncome } from "$lib/utils/tax-summary.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import Info from "lucide-svelte/icons/info";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import { onMount } from "svelte";
  import * as m from "$paraglide/messages.js";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const settings = new SettingsStore();

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
  const isGain = $derived(box3AN > 0);
  const isLoss = $derived(box3BN > 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
  const psRate = $derived(taxYear >= 2025 ? "18.6%" : "17.2%");

  // -- Regime recommender state --
  // Per-year persisted user input. Falls back to journal estimate until the user types.
  const yearKey = $derived(String(taxYear));
  let journalEstimate = $state<{ value: string; coverage: "high" | "partial" | "low" } | null>(null);

  // Reactive form values, sourced from settings (per year) with journal as fallback.
  // Stored in settings as canonical machine-format strings (e.g., "45000.5");
  // displayed in the input formatted to the active locale.
  const incomeFromSettings = $derived(settings.settings.frenchTax?.taxableIncomeByYear?.[yearKey] ?? "");
  let incomeInput = $state("");
  $effect(() => {
    const stored = incomeFromSettings;
    if (!stored) {
      incomeInput = "";
      return;
    }
    const n = parseFloat(stored);
    incomeInput = isFinite(n) ? formatNumber(n, { maximumFractionDigits: 2 }) : "";
  });

  const householdParts = $derived(settings.settings.frenchTax?.householdParts ?? 1);
  let partsInput = $state<string>("1");
  $effect(() => {
    partsInput = formatNumber(householdParts, { maximumFractionDigits: 2 });
  });

  // Load journal estimate once per year change.
  $effect(() => {
    const _year = taxYear;
    void loadJournalEstimate(_year);
  });

  async function loadJournalEstimate(year: number) {
    journalEstimate = null;
    try {
      const backend = getBackend();
      const stmt = await backend.incomeStatement(`${year}-01-01`, `${year}-12-31`);
      journalEstimate = estimateOtherTaxableIncome(stmt, "EUR");
    } catch {
      journalEstimate = null;
    }
  }

  // The income value actually used for the recommendation: user input if set,
  // otherwise the journal estimate.
  const effectiveIncome = $derived.by(() => {
    const userVal = parseLocaleNumber(incomeInput);
    if (userVal !== null && userVal >= 0) return userVal;
    if (journalEstimate) {
      const n = parseFloat(journalEstimate.value);
      if (isFinite(n) && n >= 0) return n;
    }
    return null;
  });

  const effectiveParts = $derived.by(() => {
    const n = parseLocaleNumber(partsInput);
    return n !== null && n > 0 ? n : 1;
  });

  function onIncomeBlur() {
    const n = parseLocaleNumber(incomeInput);
    const stored = n !== null && n >= 0 ? String(n) : "";
    settings.update({
      frenchTax: {
        ...settings.settings.frenchTax,
        taxableIncomeByYear: {
          ...(settings.settings.frenchTax?.taxableIncomeByYear ?? {}),
          [yearKey]: stored,
        },
      },
    });
    // Reformat the field to canonical locale display (or clear if invalid).
    incomeInput = stored ? formatNumber(parseFloat(stored), { maximumFractionDigits: 2 }) : "";
  }

  function onPartsBlur() {
    const n = parseLocaleNumber(partsInput);
    if (n !== null && n > 0) {
      settings.update({
        frenchTax: {
          ...settings.settings.frenchTax,
          householdParts: n,
        },
      });
      partsInput = formatNumber(n, { maximumFractionDigits: 2 });
    } else {
      partsInput = formatNumber(householdParts, { maximumFractionDigits: 2 });
    }
  }

  const recommendation = $derived.by(() => {
    if (!isGain) return null;
    if (report.isExempt) return null;
    if (effectiveIncome === null) return null;
    return recommendRegime({
      cryptoGain: report.box3AN,
      otherIncome: effectiveIncome,
      parts: effectiveParts,
      year: taxYear,
    });
  });

  // Show the card only when there's a positive gain over the 305€ exemption.
  const showRegimeCard = $derived(isGain && !report.isExempt);

  onMount(() => {
    void loadJournalEstimate(taxYear);
  });
</script>

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>{m.report_french_tax_2042c_card_title()}</Card.Title>
      <Card.Description>
        {#if isGain}
          {m.report_french_tax_2042c_instr_gain()}
        {:else if isLoss}
          {m.report_french_tax_2042c_instr_loss()}
        {:else}
          {m.report_french_tax_2042c_no_amount()}
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="grid gap-4 sm:grid-cols-2">
        <!-- Box 3AN -->
        <div class="rounded-md border-2 p-5 {isGain ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950' : 'border-muted bg-muted/30'}">
          <p class="text-sm font-medium {isGain ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground'}">
            {m.report_french_tax_2042c_box_3an()}
          </p>
          <p class="text-3xl font-bold mt-1 {isGain ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground/50'}">
            {formatCurrency(report.box3AN, "EUR")}
          </p>
          {#if isGain}
            <p class="text-sm mt-2 text-green-700 dark:text-green-300">
              {m.report_french_tax_2042c_box_3an_instr({ amount: formatCurrency(report.box3AN, "EUR") })}
            </p>
          {/if}
        </div>

        <!-- Box 3BN -->
        <div class="rounded-md border-2 p-5 {isLoss ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950' : 'border-muted bg-muted/30'}">
          <p class="text-sm font-medium {isLoss ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}">
            {m.report_french_tax_2042c_box_3bn()}
          </p>
          <p class="text-3xl font-bold mt-1 {isLoss ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground/50'}">
            {formatCurrency(report.box3BN, "EUR")}
          </p>
          {#if isLoss}
            <p class="text-sm mt-2 text-red-700 dark:text-red-300">
              {m.report_french_tax_2042c_box_3bn_instr({ amount: formatCurrency(report.box3BN, "EUR") })}
            </p>
          {/if}
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Regime recommender (PFU vs barème) — only when there's a positive non-exempt gain -->
  {#if showRegimeCard}
    <Card.Root>
      <Card.Header>
        <Card.Title>{m.report_french_tax_2042c_regime_card_title()}</Card.Title>
        <Card.Description>
          {m.report_french_tax_2042c_regime_card_desc()}
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <!-- Inputs: other income + fiscal parts -->
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="income-input" class="text-sm font-medium flex items-center gap-1">
              {m.label_other_taxable_income()}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  <Info class="h-3.5 w-3.5 text-muted-foreground" />
                </Tooltip.Trigger>
                <Tooltip.Content><p class="text-xs max-w-72">{m.label_other_taxable_income_hint()}</p></Tooltip.Content>
              </Tooltip.Root>
            </label>
            <Input
              id="income-input"
              type="text"
              inputmode="decimal"
              bind:value={incomeInput}
              onblur={onIncomeBlur}
              placeholder={journalEstimate ? formatNumber(parseFloat(journalEstimate.value), { maximumFractionDigits: 2 }) : "0"}
              class="w-full"
            />
            {#if journalEstimate && incomeInput.trim() === ""}
              <p class="text-xs text-muted-foreground">
                {m.label_estimated_from_journal({ value: formatCurrency(journalEstimate.value, "EUR") })}
                {#if journalEstimate.coverage !== "high"}
                  <Badge variant="outline" class="ml-1 text-[10px]">{journalEstimate.coverage}</Badge>
                {/if}
              </p>
            {/if}
          </div>
          <div class="space-y-1">
            <label for="parts-input" class="text-sm font-medium flex items-center gap-1">
              {m.label_household_parts()}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  <Info class="h-3.5 w-3.5 text-muted-foreground" />
                </Tooltip.Trigger>
                <Tooltip.Content><p class="text-xs max-w-72">{m.label_household_parts_hint()}</p></Tooltip.Content>
              </Tooltip.Root>
            </label>
            <Input
              id="parts-input"
              type="text"
              inputmode="decimal"
              bind:value={partsInput}
              onblur={onPartsBlur}
              class="w-full sm:w-32"
            />
          </div>
        </div>

        <!-- Comparison panels -->
        {#if recommendation}
          {@const isPfu = recommendation.recommendation === "pfu"}
          {@const isBareme = recommendation.recommendation === "bareme"}
          {@const tmiPercent = (recommendation.marginalRate * 100).toFixed(0)}
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="rounded-md border-2 p-4 {isPfu ? 'border-primary bg-primary/5' : 'border-muted'}">
              <div class="flex items-center justify-between">
                <p class="text-sm font-medium">{m.report_french_tax_2042c_panel_pfu_title()}</p>
                {#if isPfu}
                  <Badge variant="default" class="text-[10px]">{m.report_french_tax_2042c_recommended_badge()}</Badge>
                {/if}
              </div>
              <p class="text-xs text-muted-foreground mt-0.5">{m.report_french_tax_2042c_panel_pfu_subtitle()}</p>
              <p class="text-2xl font-semibold mt-2 font-mono">{formatCurrency(recommendation.pfuIR, "EUR")}</p>
              <p class="text-xs text-muted-foreground mt-1">
                {m.report_french_tax_2042c_panel_ir_line({ amount: formatCurrency(recommendation.pfuIR, "EUR") })}
              </p>
            </div>
            <div class="rounded-md border-2 p-4 {isBareme ? 'border-primary bg-primary/5' : 'border-muted'}">
              <div class="flex items-center justify-between">
                <p class="text-sm font-medium">{m.report_french_tax_2042c_panel_bareme_title()}</p>
                {#if isBareme}
                  <Badge variant="default" class="text-[10px]">{m.report_french_tax_2042c_recommended_badge()}</Badge>
                {/if}
              </div>
              <p class="text-xs text-muted-foreground mt-0.5">{m.report_french_tax_2042c_panel_bareme_subtitle({ rate: tmiPercent })}</p>
              <p class="text-2xl font-semibold mt-2 font-mono">{formatCurrency(recommendation.baremeIR, "EUR")}</p>
              <p class="text-xs text-muted-foreground mt-1">
                {m.report_french_tax_2042c_panel_ir_line({ amount: formatCurrency(recommendation.baremeIR, "EUR") })}
              </p>
            </div>
          </div>

          <!-- Recommendation line -->
          <div class="rounded-md border p-3 text-sm font-medium {isPfu ? 'border-primary/40 bg-primary/5' : isBareme ? 'border-primary/40 bg-primary/5' : 'border-muted'}">
            {#if isPfu}
              {m.report_french_tax_2042c_recommend_pfu({ amount: formatCurrency(recommendation.savings, "EUR") })}
            {:else if isBareme}
              {m.report_french_tax_2042c_recommend_bareme({ amount: formatCurrency(recommendation.savings, "EUR") })}
            {:else}
              {m.report_french_tax_2042c_recommend_tie()}
            {/if}
          </div>

          {#if recommendation.bracketFallbackYear !== null}
            <div class="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
              <AlertTriangle class="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{m.report_french_tax_2042c_caveat_bracket_fallback({ year: String(taxYear), fallbackYear: String(recommendation.bracketFallbackYear) })}</span>
            </div>
          {/if}
        {:else}
          <p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {m.report_french_tax_2042c_recommend_missing_input()}
          </p>
        {/if}

        <!-- Caveats -->
        <div class="space-y-2 text-xs text-muted-foreground">
          <div class="flex items-start gap-2">
            <AlertTriangle class="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{m.report_french_tax_2042c_caveat_global_pfu_income()}</span>
          </div>
          <div class="flex items-start gap-2">
            <AlertTriangle class="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{m.report_french_tax_2042c_caveat_simplified()}</span>
          </div>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- No positive gain: keep the original passive 2OP notice for context -->
    <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
      <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div class="space-y-1">
        <p class="font-medium">{m.report_french_tax_2042c_box_2op_title()}</p>
        <p class="text-muted-foreground">
          {m.report_french_tax_2042c_pfu_explainer({ rate: String(pfuRate), ps: psRate })}
        </p>
      </div>
    </div>
  {/if}

  <!-- Crypto-to-crypto note -->
  <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
    <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    <div>
      <p class="text-muted-foreground">
        {m.report_french_tax_2042c_c2c_note()}
      </p>
    </div>
  </div>
</div>
