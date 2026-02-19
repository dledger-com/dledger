<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { JournalStore } from "$lib/data/journal.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getBackend } from "$lib/backend.js";
  import { LineChart } from "layerchart";
  import { scaleTime, scaleLinear } from "d3-scale";
  import { v7 as uuidv7 } from "uuid";
  import { toast } from "svelte-sonner";
  import type { Account, CurrencyBalance, LineItem, BalanceAssertion } from "$lib/types/index.js";

  const accountStore = new AccountStore();
  const journalStore = new JournalStore();
  const settings = new SettingsStore();

  const accountId = $derived(page.params.accountId);
  let account = $state<Account | null>(null);
  let balances = $state<CurrencyBalance[]>([]);
  let loading = $state(true);
  let balanceChartData = $state<{ date: Date; value: number }[]>([]);
  let chartLoading = $state(true);
  let assertions = $state<BalanceAssertion[]>([]);
  let showAssertionForm = $state(false);
  let assertionDate = $state(new Date().toISOString().slice(0, 10));
  let assertionCurrency = $state("");
  let assertionAmount = $state("");
  const filteredEntries = $derived(filterHiddenEntries(journalStore.entries, settings.hiddenCurrencySet));
  const filteredBalances = $derived(filterHiddenBalances(balances, settings.hiddenCurrencySet));

  // Compute running balance for each entry (chronological order)
  const entriesWithRunning = $derived.by(() => {
    // Sort ascending by date for running balance computation
    const sorted = [...filteredEntries].sort((a, b) => a[0].date.localeCompare(b[0].date));
    const runningMap = new Map<string, number>();
    const result: { entry: typeof sorted[0]; running: Map<string, number> }[] = [];

    for (const [entry, items] of sorted) {
      const relevantItems = items.filter((i: LineItem) => i.account_id === accountId);
      for (const item of relevantItems) {
        const current = runningMap.get(item.currency) ?? 0;
        runningMap.set(item.currency, current + parseFloat(item.amount));
      }
      result.push({ entry: [entry, items], running: new Map(runningMap) });
    }

    // Reverse back to descending order for display
    return result.reverse();
  });

  async function loadBalanceChart(id: string) {
    chartLoading = true;
    try {
      const backend = getBackend();
      const entries = await backend.queryJournalEntries({ account_id: id });
      if (entries.length === 0) { chartLoading = false; return; }

      // Find date range
      const dates = entries.map(([e]) => e.date).sort();
      const first = new Date(dates[0]);
      const last = new Date();

      // Generate monthly dates
      const points: { date: Date; value: number }[] = [];
      const cursor = new Date(first.getFullYear(), first.getMonth(), 1);

      while (cursor <= last) {
        const endOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        const dateStr = endOfMonth.toISOString().slice(0, 10);
        const bal = await backend.getAccountBalance(id, dateStr);

        // Sum all currencies to base currency where possible
        let total = 0;
        for (const b of bal) {
          if (b.currency === settings.currency) {
            total += parseFloat(b.amount);
          } else {
            const rate = await backend.getExchangeRate(b.currency, settings.currency, dateStr);
            if (rate) total += parseFloat(b.amount) * parseFloat(rate);
            else total += parseFloat(b.amount); // Fallback: add raw amount
          }
        }
        points.push({ date: new Date(dateStr + "T00:00:00"), value: Math.round(total * 100) / 100 });
        cursor.setMonth(cursor.getMonth() + 1);
      }
      balanceChartData = points;
    } catch (e) {
      console.error("Balance chart failed:", e);
    } finally {
      chartLoading = false;
    }
  }

  onMount(async () => {
    const id = accountId;
    if (!id) { loading = false; return; }
    await accountStore.load();
    account = accountStore.byId.get(id) ?? null;
    if (account) {
      balances = await accountStore.getBalance(id);
      await journalStore.load({ account_id: id });
      loadBalanceChart(id);
      try {
        assertions = await getBackend().listBalanceAssertions(id);
      } catch { /* assertions not supported in this backend */ }
    }
    loading = false;
  });
</script>

<div class="space-y-6">
  {#if loading}
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  {:else if !account}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Account not found.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <div>
      <h1 class="text-2xl font-bold tracking-tight">{account.full_name}</h1>
      <p class="text-muted-foreground flex items-center gap-2">
        <Badge variant="outline">{account.account_type}</Badge>
        {#if account.is_archived}
          <Badge variant="destructive">Archived</Badge>
        {/if}
      </p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Description>Current Balance</Card.Description>
          <Card.Title class="text-2xl">
            {#if filteredBalances.length === 0}
              {formatCurrency(0)}
            {:else}
              {filteredBalances.map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
            {/if}
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Transactions</Card.Description>
          <Card.Title class="text-2xl">{filteredEntries.length}</Card.Title>
        </Card.Header>
      </Card.Root>
    </div>

    <!-- Balance Assertions -->
    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <div>
          <Card.Title>Balance Assertions</Card.Title>
          <Card.Description class="mt-1">Verify expected balances at specific dates.</Card.Description>
        </div>
        <Button variant="outline" size="sm" onclick={() => { showAssertionForm = !showAssertionForm; }}>
          {showAssertionForm ? "Cancel" : "Add Assertion"}
        </Button>
      </Card.Header>
      <Card.Content>
        {#if showAssertionForm}
          <div class="flex items-end gap-3 mb-4 p-3 rounded-md border bg-muted/30">
            <div class="space-y-1">
              <label for="assert-date" class="text-xs font-medium">Date</label>
              <Input id="assert-date" type="date" bind:value={assertionDate} class="w-36 h-8 text-sm" />
            </div>
            <div class="space-y-1">
              <label for="assert-currency" class="text-xs font-medium">Currency</label>
              <Input id="assert-currency" type="text" placeholder="USD" bind:value={assertionCurrency} class="w-20 h-8 text-sm" />
            </div>
            <div class="space-y-1">
              <label for="assert-amount" class="text-xs font-medium">Expected Balance</label>
              <Input id="assert-amount" type="text" placeholder="0.00" bind:value={assertionAmount} class="w-28 h-8 text-sm" />
            </div>
            <Button size="sm" onclick={async () => {
              if (!assertionCurrency || !assertionAmount || !accountId) return;
              try {
                const a: BalanceAssertion = {
                  id: uuidv7(),
                  account_id: accountId,
                  date: assertionDate,
                  currency: assertionCurrency,
                  expected_balance: assertionAmount,
                  is_passing: false,
                  actual_balance: null,
                };
                await getBackend().createBalanceAssertion(a);
                assertions = await getBackend().listBalanceAssertions(accountId);
                showAssertionForm = false;
                assertionAmount = "";
                toast.success("Assertion created");
              } catch (e) {
                toast.error(String(e));
              }
            }}>Save</Button>
          </div>
        {/if}
        {#if assertions.length === 0 && !showAssertionForm}
          <p class="text-sm text-muted-foreground text-center py-4">
            No balance assertions. Add one to verify expected balances.
          </p>
        {:else if assertions.length > 0}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Date</Table.Head>
                <Table.Head>Currency</Table.Head>
                <Table.Head class="text-right">Expected</Table.Head>
                <Table.Head class="text-right">Actual</Table.Head>
                <Table.Head>Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each assertions as a (a.id)}
                <Table.Row>
                  <Table.Cell class="text-muted-foreground">{a.date}</Table.Cell>
                  <Table.Cell>{a.currency}</Table.Cell>
                  <Table.Cell class="text-right font-mono">{formatCurrency(a.expected_balance, a.currency)}</Table.Cell>
                  <Table.Cell class="text-right font-mono">{a.actual_balance ? formatCurrency(a.actual_balance, a.currency) : "--"}</Table.Cell>
                  <Table.Cell>
                    {#if a.is_passing}
                      <Badge variant="default" class="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Pass</Badge>
                    {:else}
                      <Badge variant="destructive">Fail</Badge>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Balance Over Time Chart -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Balance Over Time</Card.Title>
      </Card.Header>
      <Card.Content>
        {#if chartLoading}
          <Skeleton class="h-40 w-full" />
        {:else if balanceChartData.length < 2}
          <p class="text-sm text-muted-foreground py-8 text-center">Not enough data for chart.</p>
        {:else}
          <div class="h-40">
            <LineChart
              data={balanceChartData}
              x="date"
              xScale={scaleTime()}
              y="value"
              yScale={scaleLinear()}
              series={[{ key: "value", label: "Balance", color: "hsl(var(--chart-1))" }]}
            />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Transaction History -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Transaction History</Card.Title>
      </Card.Header>
      {#if filteredEntries.length === 0}
        <Card.Content>
          <p class="text-sm text-muted-foreground py-8 text-center">
            No transactions for this account yet.
          </p>
        </Card.Content>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Date</Table.Head>
              <Table.Head>Description</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head class="text-right">Amount</Table.Head>
              <Table.Head class="text-right">Running Balance</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each entriesWithRunning as { entry: [entry, items], running } (entry.id)}
              {@const relevantItems = items.filter((i: LineItem) => i.account_id === accountId)}
              <Table.Row>
                <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
                <Table.Cell>
                  <a href="/journal/{entry.id}" class="hover:underline">{entry.description}</a>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={entry.status === "confirmed" ? "default" : "secondary"}>
                    {entry.status}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {#each relevantItems as item}
                    {@const amt = parseFloat(item.amount)}
                    <span class={amt >= 0 ? "" : "text-red-600 dark:text-red-400"}>
                      {formatCurrency(amt, item.currency)}
                    </span>
                  {/each}
                </Table.Cell>
                <Table.Cell class="text-right font-mono text-muted-foreground">
                  {#each [...running.entries()] as [currency, amount]}
                    <span>{formatCurrency(amount, currency)}</span>
                  {/each}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Root>
  {/if}
</div>
