<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));
  const isGain = $derived(totalPV > 0);
  const isLoss = $derived(totalPV < 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
  const taxDue = $derived(taxYear >= 2025 ? report.taxDuePFU314 : report.taxDuePFU30);
  const hasDispositions = $derived(report.dispositions.length > 0);
</script>

<Card.Root class="border-2 {isGain ? 'border-green-200 dark:border-green-800' : isLoss ? 'border-red-200 dark:border-red-800' : 'border-muted'}">
  <Card.Content class="py-5">
    {#if !hasDispositions}
      <div class="text-center">
        <p class="text-lg font-semibold text-muted-foreground">No crypto-to-fiat sales in {taxYear}</p>
        <p class="text-sm text-muted-foreground mt-1">Nothing to declare on Form 2086</p>
      </div>
    {:else if report.isExempt}
      <div class="text-center">
        <p class="text-lg font-semibold text-muted-foreground">Exempt — total dispositions under 305 EUR</p>
        <p class="text-sm text-muted-foreground mt-1">
          {report.dispositions.length} disposition{report.dispositions.length > 1 ? "s" : ""}, final acquisition cost: {formatCurrency(finalA, "EUR")}
        </p>
      </div>
    {:else if isGain}
      <div class="flex flex-col items-center gap-1">
        <p class="text-3xl font-bold text-green-600 dark:text-green-400">
          {formatCurrency(taxDue, "EUR")}
        </p>
        <p class="text-sm text-muted-foreground">
          Tax due at PFU {pfuRate}% on a gain of {formatCurrency(totalPV, "EUR")}
        </p>
        <div class="flex items-center gap-2 mt-1">
          <Badge variant="outline">Report in box 3AN</Badge>
          <span class="text-xs text-muted-foreground">
            {report.dispositions.length} disposition{report.dispositions.length > 1 ? "s" : ""}, final acquisition cost: {formatCurrency(finalA, "EUR")}
          </span>
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center gap-1">
        <p class="text-2xl font-bold text-red-600 dark:text-red-400">
          Net loss of {formatCurrency(Math.abs(totalPV), "EUR")}
        </p>
        <p class="text-sm text-muted-foreground">No tax due</p>
        <div class="flex items-center gap-2 mt-1">
          <Badge variant="outline">Report in box 3BN (informational)</Badge>
          <span class="text-xs text-muted-foreground">
            {report.dispositions.length} disposition{report.dispositions.length > 1 ? "s" : ""}, final acquisition cost: {formatCurrency(finalA, "EUR")}
          </span>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
