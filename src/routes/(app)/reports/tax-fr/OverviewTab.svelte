<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { FrenchTaxReport } from "$lib/utils/french-tax.js";
  import type { ExchangeAccount } from "$lib/cex/types.js";
  import Info from "lucide-svelte/icons/info";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";

  let {
    report,
    taxYear,
    foreignAccountCount,
  }: {
    report: FrenchTaxReport;
    taxYear: number;
    foreignAccountCount: number;
  } = $props();

  const totalPV = $derived(parseFloat(report.totalPlusValue));
  const totalFiat = $derived(parseFloat(report.totalFiatReceived));
  const finalA = $derived(parseFloat(report.finalAcquisitionCost));
  const yearEndV = $derived(parseFloat(report.yearEndPortfolioValue));
  const pfuRate = $derived(taxYear >= 2025 ? 31.4 : 30);

  const box3AN = $derived(parseFloat(report.box3AN));
  const box3BN = $derived(parseFloat(report.box3BN));
</script>

<div class="space-y-6">
  <!-- Declaration Roadmap -->
  <Card.Root>
    <Card.Header class="pb-3">
      <Card.Title class="text-base">Declaration Roadmap</Card.Title>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- Form 2086 -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">2086</Badge>
          <span class="font-medium text-sm">Crypto Dispositions (Cerfa 16043)</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          Where: impots.gouv.fr &gt; Annexes &gt; 2086
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if report.dispositions.length > 0}
            {report.dispositions.length} disposition{report.dispositions.length > 1 ? "s" : ""} to transcribe
            <span class="text-muted-foreground">(see Form 2086 tab)</span>
          {:else}
            No dispositions — nothing to fill
          {/if}
        </p>
      </div>

      <!-- Form 2042 C -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">2042 C</Badge>
          <span class="font-medium text-sm">Income Tax Summary</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          Where: Box {box3AN > 0 ? "3AN" : "3BN"}
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if box3AN > 0}
            {formatCurrency(report.box3AN, "EUR")} gain
          {:else if box3BN > 0}
            {formatCurrency(report.box3BN, "EUR")} loss
          {:else}
            No amount to report
          {/if}
        </p>
      </div>

      <!-- Form 3916-bis -->
      <div class="rounded-md border p-3 space-y-1">
        <div class="flex items-center gap-2">
          <Badge variant="outline" class="font-mono text-xs">3916-bis</Badge>
          <span class="font-medium text-sm">Foreign Account Declarations</span>
        </div>
        <p class="text-xs text-muted-foreground ml-[3.25rem]">
          Where: impots.gouv.fr &gt; Annexes &gt; 3916-bis
        </p>
        <p class="text-sm ml-[3.25rem]">
          {#if foreignAccountCount > 0}
            {foreignAccountCount} account{foreignAccountCount > 1 ? "s" : ""} to declare
            <span class="text-muted-foreground">(see Form 3916-bis tab)</span>
          {:else}
            No foreign exchange accounts configured
          {/if}
        </p>
        <div class="flex items-center gap-1.5 ml-[3.25rem] text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle class="h-3 w-3 shrink-0" />
          <span>750&#8239;EUR penalty per undeclared account</span>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Summary Metrics -->
  <div class="grid gap-4 sm:grid-cols-2">
    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>Total Plus-Value</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">Net taxable gain from all crypto-to-fiat sales in {taxYear}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl {totalPV >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
          {totalPV >= 0 ? "+" : ""}{formatCurrency(totalPV, "EUR")}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>Total Fiat Received</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">Total EUR received from crypto sales (sum of all C values)</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(totalFiat, "EUR")}</Card.Title>
      </Card.Header>
      <Card.Content class="pt-0">
        {#if report.isExempt}
          <Badge variant="secondary">Exempt (&le; 305 EUR)</Badge>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>Final Acquisition Cost (A)</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">Remaining cost basis after all {taxYear} sales, carries to next year</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(finalA, "EUR")}</Card.Title>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header class="pb-2">
        <div class="flex items-center gap-1.5">
          <Card.Description>Portfolio Value (Dec 31)</Card.Description>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Info class="h-3.5 w-3.5 text-muted-foreground" />
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p class="max-w-52 text-xs">Total crypto portfolio value at year end in EUR</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <Card.Title class="text-xl">{formatCurrency(yearEndV, "EUR")}</Card.Title>
      </Card.Header>
    </Card.Root>
  </div>

  <!-- PFU Rate Note -->
  <div class="text-xs text-muted-foreground">
    {#if taxYear >= 2025}
      PFU rate: 31.4% (12.8% IR + 18.6% PS — CSG increase effective 2025).
      Prior years used 30% (12.8% IR + 17.2% PS).
    {:else}
      PFU rate: 30% (12.8% IR + 17.2% PS).
      At PFU 30%: {formatCurrency(report.taxDuePFU30, "EUR")}.
    {/if}
    {#if taxYear < 2025}
      At PFU 31.4%: {formatCurrency(report.taxDuePFU314, "EUR")}.
    {:else}
      At PFU 30%: {formatCurrency(report.taxDuePFU30, "EUR")}.
    {/if}
  </div>

  <!-- Warnings -->
  {#if report.warnings.length > 0}
    <Card.Root>
      <Card.Header>
        <div class="flex items-center gap-2">
          <AlertTriangle class="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <Card.Title>Warnings</Card.Title>
        </div>
      </Card.Header>
      <Card.Content>
        <ul class="space-y-1 text-sm text-muted-foreground">
          {#each report.warnings as w}
            <li>{w}</li>
          {/each}
        </ul>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
