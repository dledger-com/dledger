<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as ButtonGroup from "$lib/components/ui/button-group/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import { recommendRegime } from "$lib/utils/french-bareme.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import Decimal from "decimal.js-light";
  import * as m from "$paraglide/messages.js";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const settings = new SettingsStore();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));
  const isGain = $derived(totalPV > 0);
  const isLoss = $derived(totalPV < 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
  const psRateDec = $derived(taxYear >= 2025 ? new Decimal("0.186") : new Decimal("0.172"));
  const psRateLabel = $derived(taxYear >= 2025 ? "18.6" : "17.2");
  const pfuTaxDue = $derived(taxYear >= 2025 ? report.taxDuePFU314 : report.taxDuePFU30);
  const hasDispositions = $derived(report.dispositions.length > 0);
  const dispCount = $derived(report.dispositions.length);
  const dispSummary = $derived(
    dispCount === 1
      ? m.report_french_tax_disp_summary_one({ cost: formatCurrency(finalA, "EUR") })
      : m.report_french_tax_disp_summary_other({ count: String(dispCount), cost: formatCurrency(finalA, "EUR") }),
  );

  // Regime recommendation — only when the user has supplied other taxable income.
  const yearKey = $derived(String(taxYear));
  const otherIncome = $derived.by(() => {
    const stored = settings.settings.frenchTax?.taxableIncomeByYear?.[yearKey];
    if (!stored) return null;
    const n = parseFloat(stored);
    return isFinite(n) && n >= 0 ? n : null;
  });
  const householdParts = $derived(settings.settings.frenchTax?.householdParts ?? 1);

  const recommendation = $derived.by(() => {
    if (!isGain || report.isExempt || otherIncome === null) return null;
    return recommendRegime({
      cryptoGain: report.box3AN,
      otherIncome,
      parts: householdParts,
      year: taxYear,
    });
  });

  // Default view follows the recommendation; manual toggle overrides it.
  const recommendedView = $derived<"pfu" | "bareme">(recommendation?.recommendation === "bareme" ? "bareme" : "pfu");
  let manualView = $state<"pfu" | "bareme" | null>(null);
  const activeView = $derived(manualView ?? recommendedView);

  // Total tax under barème = marginal IR cost + social contributions on the gain.
  const baremeTaxDue = $derived.by(() => {
    if (!recommendation) return "0";
    const gain = new Decimal(report.box3AN);
    const ps = gain.times(psRateDec);
    return new Decimal(recommendation.baremeIR).plus(ps).toFixed(2);
  });

  const displayedTaxDue = $derived(activeView === "bareme" ? baremeTaxDue : pfuTaxDue);
  const baremeTmiPercent = $derived(recommendation ? (recommendation.marginalRate * 100).toFixed(0) : "0");
</script>

<Card.Root class="border-2 {isGain ? 'border-green-200 dark:border-green-800' : isLoss ? 'border-red-200 dark:border-red-800' : 'border-muted'}">
  <Card.Content class="py-5">
    {#if !hasDispositions}
      <div class="text-center">
        <p class="text-lg font-semibold text-muted-foreground">{m.report_french_tax_no_sales_in_year({ year: String(taxYear) })}</p>
        <p class="text-sm text-muted-foreground mt-1">{m.report_french_tax_nothing_to_declare_2086()}</p>
      </div>
    {:else if report.isExempt}
      <div class="text-center">
        <p class="text-lg font-semibold text-muted-foreground">{m.report_french_tax_exempt_under_305()}</p>
        <p class="text-sm text-muted-foreground mt-1">
          {dispSummary}
        </p>
      </div>
    {:else if isGain}
      <div class="flex flex-col items-center gap-1">
        {#if recommendation}
          <ButtonGroup.Root class="mb-1">
            <Button
              variant={activeView === "pfu" ? "default" : "outline"}
              size="sm"
              onclick={() => (manualView = "pfu")}
            >
              {m.report_french_tax_regime_toggle_pfu()}
              {#if recommendedView === "pfu"}
                <span class="ml-1 text-[9px] uppercase opacity-70">{m.report_french_tax_recommended_short()}</span>
              {/if}
            </Button>
            <Button
              variant={activeView === "bareme" ? "default" : "outline"}
              size="sm"
              onclick={() => (manualView = "bareme")}
            >
              {m.report_french_tax_regime_toggle_bareme()}
              {#if recommendedView === "bareme"}
                <span class="ml-1 text-[9px] uppercase opacity-70">{m.report_french_tax_recommended_short()}</span>
              {/if}
            </Button>
          </ButtonGroup.Root>
        {/if}
        <p class="text-3xl font-bold text-positive">
          {formatCurrency(displayedTaxDue, "EUR")}
        </p>
        <p class="text-sm text-muted-foreground">
          {#if activeView === "bareme" && recommendation}
            {m.report_french_tax_tax_due_bareme_on_gain({ rate: baremeTmiPercent, ps: psRateLabel, amount: formatCurrency(totalPV, "EUR") })}
          {:else}
            {m.report_french_tax_tax_due_on_gain({ rate: String(pfuRate), amount: formatCurrency(totalPV, "EUR") })}
          {/if}
        </p>
        <div class="flex items-center gap-2 mt-1">
          <Badge variant="outline">{m.report_french_tax_report_in_3an()}</Badge>
          <span class="text-xs text-muted-foreground">
            {dispSummary}
          </span>
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center gap-1">
        <p class="text-2xl font-bold text-negative">
          {m.report_french_tax_net_loss_of({ amount: formatCurrency(Math.abs(totalPV), "EUR") })}
        </p>
        <p class="text-sm text-muted-foreground">{m.report_french_tax_no_tax_due()}</p>
        <div class="flex items-center gap-2 mt-1">
          <Badge variant="outline">{m.report_french_tax_report_in_3bn_info()}</Badge>
          <span class="text-xs text-muted-foreground">
            {dispSummary}
          </span>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
