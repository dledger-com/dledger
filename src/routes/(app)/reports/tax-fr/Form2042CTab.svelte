<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import Info from "lucide-svelte/icons/info";
  import * as m from "$paraglide/messages.js";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
  const isGain = $derived(box3AN > 0);
  const isLoss = $derived(box3BN > 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
  const psRate = $derived(taxYear >= 2025 ? "18.6%" : "17.2%");
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

  <!-- Progressive scale option -->
  <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
    <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    <div class="space-y-1">
      <p class="font-medium">{m.report_french_tax_2042c_box_2op_title()}</p>
      <p class="text-muted-foreground">
        {m.report_french_tax_2042c_pfu_explainer({ rate: String(pfuRate), ps: psRate })}
      </p>
    </div>
  </div>

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
