<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { computeFrenchTaxReport, type FrenchTaxReport } from "$lib/utils/french-tax.js";
  import { exportFrenchTaxCsv } from "$lib/utils/csv-export.js";
  import {
    findMissingRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import Download from "lucide-svelte/icons/download";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import Info from "lucide-svelte/icons/info";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";

  const settings = new SettingsStore();

  let taxYear = $state(new Date().getFullYear() - 1);
  let priorAcquisitionCost = $state(settings.settings.frenchTax?.priorAcquisitionCost ?? "0");
  let loading = $state(false);
  let report = $state<FrenchTaxReport | null>(null);
  let error = $state<string | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);

  const totalPV = $derived(report ? parseFloat(report.totalPlusValue) : 0);
  const totalFiat = $derived(report ? parseFloat(report.totalFiatReceived) : 0);
  const finalA = $derived(report ? parseFloat(report.finalAcquisitionCost) : 0);
  const yearEndV = $derived(report ? parseFloat(report.yearEndPortfolioValue) : 0);

  type DispSortKey = "date" | "description" | "crypto" | "fiat" | "portfolio" | "acqCost" | "costFraction" | "plusValue";
  const sortDisp = createSortState<DispSortKey>();
  const dispAccessors: Record<DispSortKey, (d: any) => string | number | null> = {
    date: (d) => d.date,
    description: (d) => d.description,
    crypto: (d) => d.cryptoCurrencies.join(","),
    fiat: (d) => parseFloat(d.fiatReceived),
    portfolio: (d) => parseFloat(d.portfolioValue),
    acqCost: (d) => parseFloat(d.acquisitionCostBefore),
    costFraction: (d) => parseFloat(d.costFraction),
    plusValue: (d) => parseFloat(d.plusValue),
  };

  type AcqSortKey = "date" | "description" | "crypto" | "fiatSpent";
  const sortAcq = createSortState<AcqSortKey>();
  const acqAccessors: Record<AcqSortKey, (a: any) => string | number | null> = {
    date: (a) => a.date,
    description: (a) => a.description,
    crypto: (a) => a.cryptoCurrencies.join(","),
    fiatSpent: (a) => parseFloat(a.fiatSpent),
  };

  async function generate() {
    loading = true;
    error = null;
    report = null;
    missingRateRequests = [];

    // Save prior acquisition cost to settings
    settings.update({
      frenchTax: {
        ...settings.settings.frenchTax,
        priorAcquisitionCost: priorAcquisitionCost,
      },
    });

    try {
      report = await computeFrenchTaxReport(getBackend(), {
        taxYear,
        priorAcquisitionCost,
        fiatCurrencies: settings.settings.frenchTax?.fiatCurrencies,
      });
      if (report.missingCurrencyDates.length > 0) {
        missingRateRequests = await findMissingRates(
          getBackend(),
          "EUR",
          report.missingCurrencyDates,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">French Crypto Tax Report</h1>
    <p class="text-muted-foreground">Art. 150 VH bis CGI — Weighted average method for crypto-to-fiat dispositions.</p>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>Report Parameters</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex items-start gap-4 flex-wrap">
        <div class="space-y-1">
          <label for="year" class="text-sm font-medium">Tax Year</label>
          <Input id="year" type="number" bind:value={taxYear} class="w-28" min="2019" />
        </div>
        <div class="space-y-1">
          <label for="prior-a" class="text-sm font-medium">Prior Acquisition Cost (EUR)</label>
          <Input id="prior-a" type="text" bind:value={priorAcquisitionCost} class="w-40" placeholder="0.00" />
          <p class="text-xs text-muted-foreground">Total EUR spent on crypto before your dledger data.</p>
        </div>
        <div class="pt-6">
          <div class="flex gap-2">
            <Button onclick={generate} disabled={loading}>
              {loading ? "Generating..." : "Generate"}
            </Button>
            {#if report}
              <Button variant="outline" onclick={() => exportFrenchTaxCsv(report!)}>
                <Download class="mr-1 h-4 w-4" />
                CSV
              </Button>
            {/if}
          </div>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

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
    <!-- Summary Cards -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Total Plus-Value</Card.Description>
          <Card.Title class="text-xl {totalPV >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
            {totalPV >= 0 ? "+" : ""}{formatCurrency(totalPV, "EUR")}
          </Card.Title>
        </Card.Header>
        <Card.Content class="pt-0">
          <p class="text-xs text-muted-foreground">
            {#if totalPV >= 0}Box 3AN{:else}Box 3BN{/if}
          </p>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Total Fiat Received</Card.Description>
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
          <Card.Description>Tax at PFU</Card.Description>
          <Card.Title class="text-xl">{formatCurrency(report.taxDuePFU30, "EUR")}</Card.Title>
        </Card.Header>
        <Card.Content class="pt-0">
          <p class="text-xs text-muted-foreground">
            30% flat tax (12.8% IR + 17.2% PS)
          </p>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Final Acquisition Cost (A)</Card.Description>
          <Card.Title class="text-xl">{formatCurrency(finalA, "EUR")}</Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Portfolio Value (Dec 31)</Card.Description>
          <Card.Title class="text-xl">{formatCurrency(yearEndV, "EUR")}</Card.Title>
        </Card.Header>
      </Card.Root>

      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Description>Tax at PFU (31.4%)</Card.Description>
          <Card.Title class="text-xl">{formatCurrency(report.taxDuePFU314, "EUR")}</Card.Title>
        </Card.Header>
        <Card.Content class="pt-0">
          <p class="text-xs text-muted-foreground">
            Including contribution exceptionnelle
          </p>
        </Card.Content>
      </Card.Root>
    </div>

    <!-- Form 2086 Table -->
    {#if report.dispositions.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Dispositions (Form 2086)</Card.Title>
          <Card.Description>One row per crypto-to-fiat sale event.</Card.Description>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head class="w-10">#</Table.Head>
                <SortableHeader active={sortDisp.key === "date"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("date")}>Date</SortableHeader>
                <SortableHeader active={sortDisp.key === "description"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("description")} class="hidden sm:table-cell">Description</SortableHeader>
                <SortableHeader active={sortDisp.key === "crypto"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("crypto")}>Crypto</SortableHeader>
                <SortableHeader active={sortDisp.key === "fiat"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("fiat")} class="text-right">C (Fiat)</SortableHeader>
                <SortableHeader active={sortDisp.key === "portfolio"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("portfolio")} class="text-right hidden md:table-cell">V (Portfolio)</SortableHeader>
                <SortableHeader active={sortDisp.key === "acqCost"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("acqCost")} class="text-right hidden md:table-cell">A (Acq. Cost)</SortableHeader>
                <SortableHeader active={sortDisp.key === "costFraction"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("costFraction")} class="text-right hidden lg:table-cell">A*C/V</SortableHeader>
                <SortableHeader active={sortDisp.key === "plusValue"} direction={sortDisp.direction} onclick={() => sortDisp.toggle("plusValue")} class="text-right">Plus-Value</SortableHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {@const sortedDisp = sortDisp.key && sortDisp.direction ? sortItems(report.dispositions, dispAccessors[sortDisp.key], sortDisp.direction) : report.dispositions}
              {#each sortedDisp as d, i (d.entryId)}
                {@const pv = parseFloat(d.plusValue)}
                <Table.Row>
                  <Table.Cell class="font-mono text-muted-foreground">{i + 1}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{d.date}</Table.Cell>
                  <Table.Cell class="hidden sm:table-cell max-w-48 truncate">{d.description}</Table.Cell>
                  <Table.Cell>
                    {#each d.cryptoCurrencies as c}
                      <Badge variant="outline" class="mr-1">{c}</Badge>
                    {/each}
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">{formatCurrency(d.fiatReceived, "EUR")}</Table.Cell>
                  <Table.Cell class="text-right font-mono hidden md:table-cell">{formatCurrency(d.portfolioValue, "EUR")}</Table.Cell>
                  <Table.Cell class="text-right font-mono hidden md:table-cell">{formatCurrency(d.acquisitionCostBefore, "EUR")}</Table.Cell>
                  <Table.Cell class="text-right font-mono hidden lg:table-cell">{formatCurrency(d.costFraction, "EUR")}</Table.Cell>
                  <Table.Cell class="text-right font-mono {pv >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                    {pv >= 0 ? "+" : ""}{formatCurrency(pv, "EUR")}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
            <Table.Footer>
              <Table.Row>
                <Table.Cell colspan={4} class="font-medium">Total</Table.Cell>
                <Table.Cell class="text-right font-mono font-medium">{formatCurrency(totalFiat, "EUR")}</Table.Cell>
                <Table.Cell class="hidden md:table-cell"></Table.Cell>
                <Table.Cell class="hidden md:table-cell"></Table.Cell>
                <Table.Cell class="hidden lg:table-cell"></Table.Cell>
                <Table.Cell class="text-right font-mono font-medium {totalPV >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                  {totalPV >= 0 ? "+" : ""}{formatCurrency(totalPV, "EUR")}
                </Table.Cell>
              </Table.Row>
            </Table.Footer>
          </Table.Root>
        </div>
      </Card.Root>
    {:else}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No crypto-to-fiat dispositions in {report.taxYear}.
          </p>
        </Card.Content>
      </Card.Root>
    {/if}

    <!-- Form 2042 C Summary -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Form 2042 C Summary</Card.Title>
        <Card.Description>Values to report on your income tax declaration.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="rounded-md border p-4">
            <p class="text-sm font-medium text-muted-foreground">Box 3AN — Plus-values</p>
            <p class="text-2xl font-bold">{formatCurrency(report.box3AN, "EUR")}</p>
          </div>
          <div class="rounded-md border p-4">
            <p class="text-sm font-medium text-muted-foreground">Box 3BN — Moins-values</p>
            <p class="text-2xl font-bold">{formatCurrency(report.box3BN, "EUR")}</p>
          </div>
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Declaration Guide -->
    <Collapsible.Root>
      <Card.Root>
        <Collapsible.Trigger class="w-full">
          <Card.Header class="flex flex-row items-center justify-between">
            <div class="flex items-center gap-2">
              <Info class="h-4 w-4 text-muted-foreground" />
              <Card.Title>Declaration Guide</Card.Title>
            </div>
            <ChevronDown class="h-4 w-4 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
          </Card.Header>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Card.Content class="prose prose-sm dark:prose-invert max-w-none">
            <ol class="space-y-2 text-sm">
              <li><strong>Form 2086:</strong> Fill one row per disposition from the table above. Fields 211-224 map to each column.</li>
              <li><strong>Form 2042 C:</strong> Report the total plus-value in box <strong>3AN</strong> (gains) or <strong>3BN</strong> (losses).</li>
              <li><strong>Exemption:</strong> If total fiat dispositions &le; 305 EUR, the plus-value is exempt from tax. You should still declare it.</li>
              <li><strong>PFU (Flat Tax):</strong> The default rate is 30% (12.8% income tax + 17.2% social contributions). You can opt for the progressive income tax scale instead.</li>
              <li><strong>Carry forward:</strong> The final acquisition cost (A) at year end carries over as the starting A for the next tax year. Save it for next year's declaration.</li>
              <li><strong>Crypto-to-crypto:</strong> Exchanges between crypto assets are NOT taxable events under Art. 150 VH bis.</li>
            </ol>
          </Card.Content>
        </Collapsible.Content>
      </Card.Root>
    </Collapsible.Root>

    <MissingRateBanner requests={missingRateRequests} onFetched={generate} baseCurrency="EUR" />

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

    <!-- Acquisitions Reference -->
    {#if report.acquisitions.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Acquisitions Reference</Card.Title>
          <Card.Description>Fiat-to-crypto purchases that contributed to acquisition cost (A).</Card.Description>
        </Card.Header>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <SortableHeader active={sortAcq.key === "date"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("date")}>Date</SortableHeader>
                <SortableHeader active={sortAcq.key === "description"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("description")} class="hidden sm:table-cell">Description</SortableHeader>
                <SortableHeader active={sortAcq.key === "crypto"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("crypto")}>Crypto</SortableHeader>
                <SortableHeader active={sortAcq.key === "fiatSpent"} direction={sortAcq.direction} onclick={() => sortAcq.toggle("fiatSpent")} class="text-right">Fiat Spent (EUR)</SortableHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {@const sortedAcq = sortAcq.key && sortAcq.direction ? sortItems(report.acquisitions, acqAccessors[sortAcq.key], sortAcq.direction) : report.acquisitions}
              {#each sortedAcq as a (a.entryId)}
                <Table.Row>
                  <Table.Cell class="text-muted-foreground">{a.date}</Table.Cell>
                  <Table.Cell class="hidden sm:table-cell max-w-48 truncate">{a.description}</Table.Cell>
                  <Table.Cell>
                    {#each a.cryptoCurrencies as c}
                      <Badge variant="outline" class="mr-1">{c}</Badge>
                    {/each}
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">{formatCurrency(a.fiatSpent, "EUR")}</Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Root>
    {/if}
  {/if}
</div>
