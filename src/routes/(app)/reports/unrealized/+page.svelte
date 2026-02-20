<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { getBackend } from "$lib/backend.js";
  import { computeUnrealizedGainLoss } from "$lib/utils/unrealized-gains.js";
  import { exportUnrealizedGainLossCsv } from "$lib/utils/csv-export.js";
  import type { UnrealizedGainLossReport } from "$lib/types/index.js";
  import Download from "lucide-svelte/icons/download";

  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let report = $state<UnrealizedGainLossReport | null>(null);
  let missingRates = $state<string[]>([]);
  let error = $state<string | null>(null);

  async function generate() {
    loading = true;
    error = null;
    report = null;
    missingRates = [];
    try {
      const result = await computeUnrealizedGainLoss(getBackend(), {
        baseCurrency: settings.currency,
        asOfDate: asOf,
      });
      report = result.report;
      missingRates = result.missingRates;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Unrealized Gains/Losses</h1>
    <p class="text-muted-foreground">Open positions valued at current exchange rates.</p>
  </div>

  <div class="flex items-end gap-4">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">As of Date</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? "Loading..." : "Generate"}
    </Button>
    {#if report}
      <Button variant="outline" onclick={() => exportUnrealizedGainLossCsv(report!)}>
        <Download class="mr-1 h-4 w-4" />
        CSV
      </Button>
    {/if}
  </div>

  {#if missingRates.length > 0}
    <Card.Root class="border-amber-200 dark:border-amber-800">
      <Card.Content class="flex items-center justify-between py-3">
        <span class="text-sm">
          Missing exchange rates for: {missingRates.join(", ")}. Values may be incomplete.
        </span>
        <Button size="sm" variant="outline" href="/sources">
          Fetch Rates
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if report}
    <!-- Summary -->
    {@const total = parseFloat(report.total_unrealized)}
    <Card.Root>
      <Card.Header>
        <Card.Description>Total Unrealized Gain/Loss</Card.Description>
        <Card.Title class="text-2xl {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
          {total >= 0 ? "+" : ""}{formatCurrency(total, report.base_currency)}
        </Card.Title>
      </Card.Header>
    </Card.Root>

    {#if report.lines.length === 0}
      <Card.Root>
        <Card.Content class="py-8">
          <p class="text-sm text-muted-foreground text-center">
            No open lots. All positions have been fully disposed.
          </p>
        </Card.Content>
      </Card.Root>
    {:else}
      <Card.Root>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Currency</Table.Head>
              <Table.Head>Account</Table.Head>
              <Table.Head>Acquired</Table.Head>
              <Table.Head class="text-right">Quantity</Table.Head>
              <Table.Head class="text-right">Cost/Unit</Table.Head>
              <Table.Head class="text-right">Current Value</Table.Head>
              <Table.Head class="text-right">Unrealized G/L</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each report.lines as line}
              {@const gl = parseFloat(line.unrealized_gain_loss)}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                <Table.Cell class="text-sm">{line.account_name}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{line.acquired_date}</Table.Cell>
                <Table.Cell class="text-right font-mono">{line.quantity}</Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {formatCurrency(parseFloat(line.cost_basis_per_unit), line.cost_basis_currency)}
                </Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {formatCurrency(parseFloat(line.current_value), report.base_currency)}
                </Table.Cell>
                <Table.Cell class="text-right font-mono {gl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                  {gl >= 0 ? "+" : ""}{formatCurrency(gl, report.base_currency)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          <Table.Footer>
            <Table.Row>
              <Table.Cell colspan={6} class="font-medium">Total</Table.Cell>
              <Table.Cell class="text-right font-mono font-medium {total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                {total >= 0 ? "+" : ""}{formatCurrency(total, report.base_currency)}
              </Table.Cell>
            </Table.Row>
          </Table.Footer>
        </Table.Root>
      </Card.Root>
    {/if}
  {/if}
</div>
