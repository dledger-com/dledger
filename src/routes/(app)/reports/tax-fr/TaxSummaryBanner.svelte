<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import * as m from "$paraglide/messages.js";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));
  const isGain = $derived(totalPV > 0);
  const isLoss = $derived(totalPV < 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
  const taxDue = $derived(taxYear >= 2025 ? report.taxDuePFU314 : report.taxDuePFU30);
  const hasDispositions = $derived(report.dispositions.length > 0);
  const dispCount = $derived(report.dispositions.length);
  const dispSummary = $derived(
    dispCount === 1
      ? m.report_french_tax_disp_summary_one({ cost: formatCurrency(finalA, "EUR") })
      : m.report_french_tax_disp_summary_other({ count: String(dispCount), cost: formatCurrency(finalA, "EUR") }),
  );
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
        <p class="text-3xl font-bold text-positive">
          {formatCurrency(taxDue, "EUR")}
        </p>
        <p class="text-sm text-muted-foreground">
          {m.report_french_tax_tax_due_on_gain({ rate: String(pfuRate), amount: formatCurrency(totalPV, "EUR") })}
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
