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
  import { computeProtocolPnL, type ProtocolPnL } from "$lib/utils/protocol-pnl.js";
  import * as m from "$paraglide/messages.js";

  const settings = new SettingsStore();
  let fromDate = $state(`${new Date().getFullYear()}-01-01`);
  let toDate = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let protocols = $state<ProtocolPnL[]>([]);
  let error = $state<string | null>(null);

  async function generate() {
    loading = true;
    error = null;
    protocols = [];
    try {
      protocols = await computeProtocolPnL(
        getBackend(),
        fromDate,
        toDate,
        settings.currency,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="from" class="text-sm font-medium">{m.label_from()}</label>
      <Input id="from" type="date" bind:value={fromDate} class="w-full sm:w-48" />
    </div>
    <div class="space-y-2">
      <label for="to" class="text-sm font-medium">{m.label_to()}</label>
      <Input id="to" type="date" bind:value={toDate} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? m.state_loading() : m.btn_generate()}
    </Button>
  </div>

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
  {:else if protocols.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_defi_activity()}
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    {#each protocols as proto (proto.protocol)}
      <Card.Root>
        <Card.Header>
          <Card.Title class="flex items-center gap-2">
            {proto.displayName}
            {#if proto.netIncomeBase !== undefined}
              {@const net = parseFloat(proto.netIncomeBase)}
              <Badge variant={net >= 0 ? "default" : "destructive"}>
                {net >= 0 ? "+" : ""}{formatCurrency(net, settings.currency)}
              </Badge>
            {/if}
          </Card.Title>
        </Card.Header>

        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>{m.label_type()}</Table.Head>
              <Table.Head>{m.label_currency()}</Table.Head>
              <Table.Head class="text-right">{m.label_amount()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each proto.revenue as line}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline" class="text-green-600 dark:text-green-400 border-green-300 dark:border-green-700">{m.report_revenue()}</Badge>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono text-green-600 dark:text-green-400">
                  +{formatCurrency(parseFloat(line.amount), line.currency)}
                </Table.Cell>
              </Table.Row>
            {/each}
            {#each proto.expenses as line}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="outline" class="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700">{m.report_expense()}</Badge>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">{line.currency}</Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono text-red-600 dark:text-red-400">
                  -{formatCurrency(parseFloat(line.amount), line.currency)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
          {#if proto.revenueBase !== undefined || proto.expensesBase !== undefined}
            <Table.Footer>
              {#if proto.revenueBase !== undefined}
                <Table.Row>
                  <Table.Cell colspan={2} class="font-medium">{m.report_total_revenue_currency({ currency: settings.currency })}</Table.Cell>
                  <Table.Cell class="text-right font-mono font-medium text-green-600 dark:text-green-400">
                    +{formatCurrency(parseFloat(proto.revenueBase), settings.currency)}
                  </Table.Cell>
                </Table.Row>
              {/if}
              {#if proto.expensesBase !== undefined}
                <Table.Row>
                  <Table.Cell colspan={2} class="font-medium">{m.report_total_expenses_currency({ currency: settings.currency })}</Table.Cell>
                  <Table.Cell class="text-right font-mono font-medium text-red-600 dark:text-red-400">
                    -{formatCurrency(parseFloat(proto.expensesBase), settings.currency)}
                  </Table.Cell>
                </Table.Row>
              {/if}
              {#if proto.netIncomeBase !== undefined}
                {@const net = parseFloat(proto.netIncomeBase)}
                <Table.Row class="font-bold">
                  <Table.Cell colspan={2}>{m.report_net_income_currency({ currency: settings.currency })}</Table.Cell>
                  <Table.Cell class="text-right font-mono {net >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
                    {net >= 0 ? "+" : ""}{formatCurrency(net, settings.currency)}
                  </Table.Cell>
                </Table.Row>
              {/if}
            </Table.Footer>
          {/if}
        </Table.Root>
      </Card.Root>
    {/each}
  {/if}
</div>
