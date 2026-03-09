<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import Info from "lucide-svelte/icons/info";

  let { report, taxYear }: { report: FrenchTaxReport; taxYear: number } = $props();

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
  const isGain = $derived(box3AN > 0);
  const isLoss = $derived(box3BN > 0);
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);
</script>

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Form 2042 C — Plus-values et gains divers</Card.Title>
      <Card.Description>
        {#if isGain}
          Enter the amount below in box <strong>3AN</strong> on your Form 2042 C.
        {:else if isLoss}
          Enter the amount below in box <strong>3BN</strong> on your Form 2042 C (informational, no tax due).
        {:else}
          No amount to report — no crypto-to-fiat sales with gains or losses.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="grid gap-4 sm:grid-cols-2">
        <!-- Box 3AN -->
        <div class="rounded-md border-2 p-5 {isGain ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950' : 'border-muted bg-muted/30'}">
          <p class="text-sm font-medium {isGain ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground'}">
            Box 3AN — Plus-values
          </p>
          <p class="text-3xl font-bold mt-1 {isGain ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground/50'}">
            {formatCurrency(report.box3AN, "EUR")}
          </p>
          {#if isGain}
            <p class="text-sm mt-2 text-green-700 dark:text-green-300">
              On Form 2042 C, section "Plus-values et gains divers", enter <strong>{formatCurrency(report.box3AN, "EUR")}</strong> in box <strong>3AN</strong>.
            </p>
          {/if}
        </div>

        <!-- Box 3BN -->
        <div class="rounded-md border-2 p-5 {isLoss ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950' : 'border-muted bg-muted/30'}">
          <p class="text-sm font-medium {isLoss ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}">
            Box 3BN — Moins-values
          </p>
          <p class="text-3xl font-bold mt-1 {isLoss ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground/50'}">
            {formatCurrency(report.box3BN, "EUR")}
          </p>
          {#if isLoss}
            <p class="text-sm mt-2 text-red-700 dark:text-red-300">
              On Form 2042 C, section "Plus-values et gains divers", enter <strong>{formatCurrency(report.box3BN, "EUR")}</strong> in box <strong>3BN</strong>.
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
      <p class="font-medium">Option for progressive scale (box 2OP)</p>
      <p class="text-muted-foreground">
        The default PFU rate is {pfuRate}% (12.8% income tax + {taxYear >= 2025 ? "18.6%" : "17.2%"} social contributions).
        If your marginal tax rate is below 12.8%, opting for the progressive income tax scale (box 2OP on Form 2042)
        may reduce your tax. This applies to all your investment income for the year, not just crypto.
      </p>
    </div>
  </div>

  <!-- Crypto-to-crypto note -->
  <div class="flex items-start gap-2 rounded-md border p-3 text-sm">
    <Info class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    <div>
      <p class="text-muted-foreground">
        <strong>Crypto-to-crypto exchanges</strong> are not taxable events under Art. 150 VH bis. Only sales from crypto to fiat currency (EUR) trigger taxation.
      </p>
    </div>
  </div>
</div>
