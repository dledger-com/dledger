<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { ExtensionStore } from "$lib/data/extensions.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";

  const extensionStore = new ExtensionStore();
  const settings = new SettingsStore();

  const PLUGIN_ID = "tax-report-fr";
  let fiscalYear = $state(new Date().getFullYear());
  let loading = $state(false);
  let report = $state<TaxReport | null>(null);
  let pluginAvailable = $derived(extensionStore.byId.has(PLUGIN_ID));

  interface Cession {
    date: string;
    asset: string;
    quantity: string;
    cession_price: number;
    portfolio_value: number;
    total_acquisition_cost: number;
    fraction: number;
    plus_value: number;
  }

  interface ExchangeAccount {
    name: string;
    platform: string;
    opened_date: string;
  }

  interface TaxReport {
    fiscal_year: number;
    total_plus_values: number;
    total_minus_values: number;
    net_result: number;
    cessions: Cession[];
    exchange_accounts: ExchangeAccount[];
  }

  async function generate() {
    loading = true;
    report = null;
    try {
      const params = JSON.stringify({
        fiscal_year: fiscalYear,
        base_currency: settings.currency,
      });
      const result = await extensionStore.runHandler(PLUGIN_ID, params);
      report = JSON.parse(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      loading = false;
    }
  }

  async function exportReport(format: string) {
    try {
      const params = JSON.stringify({
        fiscal_year: fiscalYear,
        base_currency: settings.currency,
      });
      const bytes = await extensionStore.generateReport(PLUGIN_ID, format, params);
      const ext = format === "json" ? "json" : "csv";
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tax-report-${fiscalYear}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Report exported as ${format.toUpperCase()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function formatEur(n: number): string {
    return n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
  }

  onMount(() => extensionStore.load());
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Tax Report</h1>
    <p class="text-muted-foreground">French tax report (Formulaire 2086 &amp; 3916-bis).</p>
  </div>

  {#if extensionStore.loading}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Loading plugins...</p>
      </Card.Content>
    </Card.Root>
  {:else if !pluginAvailable}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          The <code>tax-report-fr</code> plugin is not installed. Install it in the plugins directory to generate French tax reports.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Controls -->
    <Card.Root>
      <Card.Content class="flex items-end gap-4 py-4">
        <div class="space-y-2">
          <label for="fiscal-year" class="text-sm font-medium">Fiscal Year</label>
          <Input id="fiscal-year" type="number" bind:value={fiscalYear} class="w-32" />
        </div>
        <Button disabled={loading} onclick={generate}>
          {loading ? "Generating..." : "Generate Report"}
        </Button>
        {#if report}
          <Button variant="outline" onclick={() => exportReport("json")}>Export JSON</Button>
          <Button variant="outline" onclick={() => exportReport("csv")}>Export CSV</Button>
        {/if}
      </Card.Content>
    </Card.Root>

    {#if report}
      <!-- Summary -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>Total Plus-Values</Card.Description>
          </Card.Header>
          <Card.Content>
            <p class="text-2xl font-bold text-green-600">{formatEur(report.total_plus_values)}</p>
          </Card.Content>
        </Card.Root>
        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>Total Minus-Values</Card.Description>
          </Card.Header>
          <Card.Content>
            <p class="text-2xl font-bold text-red-600">{formatEur(report.total_minus_values)}</p>
          </Card.Content>
        </Card.Root>
        <Card.Root>
          <Card.Header class="pb-2">
            <Card.Description>Net Result</Card.Description>
          </Card.Header>
          <Card.Content>
            <p class="text-2xl font-bold" class:text-green-600={report.net_result >= 0} class:text-red-600={report.net_result < 0}>
              {formatEur(report.net_result)}
            </p>
          </Card.Content>
        </Card.Root>
      </div>

      <!-- Formulaire 2086 - Cessions -->
      {#if report.cessions.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Formulaire 2086 - Cessions</Card.Title>
            <Card.Description>Detail of each taxable disposal event.</Card.Description>
          </Card.Header>
          <Card.Content>
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  <Table.Head>Asset</Table.Head>
                  <Table.Head class="text-right">Qty</Table.Head>
                  <Table.Head class="text-right">Cession Price</Table.Head>
                  <Table.Head class="text-right">Portfolio Value</Table.Head>
                  <Table.Head class="text-right">Acquisition Cost</Table.Head>
                  <Table.Head class="text-right">Fraction</Table.Head>
                  <Table.Head class="text-right">Plus/Minus Value</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each report.cessions as c}
                  <Table.Row>
                    <Table.Cell>{c.date}</Table.Cell>
                    <Table.Cell><Badge variant="outline">{c.asset}</Badge></Table.Cell>
                    <Table.Cell class="text-right">{c.quantity}</Table.Cell>
                    <Table.Cell class="text-right">{formatEur(c.cession_price)}</Table.Cell>
                    <Table.Cell class="text-right">{formatEur(c.portfolio_value)}</Table.Cell>
                    <Table.Cell class="text-right">{formatEur(c.total_acquisition_cost)}</Table.Cell>
                    <Table.Cell class="text-right">{c.fraction.toFixed(6)}</Table.Cell>
                    <Table.Cell class={`text-right ${c.plus_value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatEur(c.plus_value)}
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </Card.Content>
        </Card.Root>
      {/if}

      <!-- Formulaire 3916-bis - Exchange Accounts -->
      {#if report.exchange_accounts.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Formulaire 3916-bis - Exchange Accounts</Card.Title>
            <Card.Description>Foreign exchange platform accounts to declare.</Card.Description>
          </Card.Header>
          <Card.Content>
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Account Name</Table.Head>
                  <Table.Head>Platform</Table.Head>
                  <Table.Head>Opened</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each report.exchange_accounts as acc}
                  <Table.Row>
                    <Table.Cell class="font-medium">{acc.name}</Table.Cell>
                    <Table.Cell>{acc.platform}</Table.Cell>
                    <Table.Cell>{acc.opened_date}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </Card.Content>
        </Card.Root>
      {/if}
    {/if}
  {/if}
</div>
