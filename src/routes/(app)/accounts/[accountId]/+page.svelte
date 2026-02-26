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
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { LineChart } from "layerchart";
  import { scaleTime, scaleLinear } from "d3-scale";
  import { v7 as uuidv7 } from "uuid";
  import { toast } from "svelte-sonner";
  import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
  import type { Account, CurrencyBalance, JournalEntry, LineItem, BalanceAssertion } from "$lib/types/index.js";
  import Pagination from "$lib/components/Pagination.svelte";

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
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const filteredEntries = $derived(filterHiddenEntries(journalStore.entries, hidden));
  const filteredBalances = $derived(filterHiddenBalances(balances, hidden));

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

  async function loadBalanceChart(id: string, entries: [JournalEntry, LineItem[]][]) {
    chartLoading = true;
    try {
      if (entries.length === 0) { chartLoading = false; return; }

      // Sort entries chronologically and compute running balance per currency
      const sorted = [...entries].sort((a, b) => a[0].date.localeCompare(b[0].date));
      const runningMap = new Map<string, number>();
      // Build per-entry snapshots: [date, balances]
      const snapshots: { date: string; balances: Map<string, number> }[] = [];
      for (const [entry, items] of sorted) {
        const relevantItems = items.filter((i) => i.account_id === id);
        for (const item of relevantItems) {
          const current = runningMap.get(item.currency) ?? 0;
          runningMap.set(item.currency, current + parseFloat(item.amount));
        }
        snapshots.push({ date: entry.date, balances: new Map(runningMap) });
      }

      // Find date range
      const first = new Date(snapshots[0].date);
      const last = new Date();

      // Generate monthly end-of-month points
      const points: { date: Date; value: number }[] = [];
      const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
      const rateCache = new ExchangeRateCache(getBackend());
      const baseCurrency = settings.currency;

      while (cursor <= last) {
        const endOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        const dateStr = endOfMonth.toISOString().slice(0, 10);

        // Find the last snapshot on or before this date
        let balAtMonth: Map<string, number> | null = null;
        for (let i = snapshots.length - 1; i >= 0; i--) {
          if (snapshots[i].date <= dateStr) {
            balAtMonth = snapshots[i].balances;
            break;
          }
        }

        let total = 0;
        if (balAtMonth) {
          for (const [currency, amount] of balAtMonth) {
            if (currency === baseCurrency) {
              total += amount;
            } else {
              const rate = await rateCache.get(currency, baseCurrency, dateStr);
              if (rate) total += amount * parseFloat(rate);
              else total += amount; // Fallback: add raw amount
            }
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
    const [, balResult, , assertResult] = await Promise.all([
      accountStore.load(),
      accountStore.getBalance(id),
      journalStore.load({ account_id: id }),
      getBackend().listBalanceAssertions(id).catch(() => [] as BalanceAssertion[]),
    ]);
    account = accountStore.byId.get(id) ?? null;
    balances = balResult;
    assertions = assertResult;
    if (account) loadBalanceChart(id, journalStore.entries);
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
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">{account.full_name}</h1>
        <p class="text-muted-foreground flex items-center gap-2">
          <Badge variant="outline">{account.account_type}</Badge>
          {#if account.is_archived}
            <Badge variant="destructive">Archived</Badge>
          {/if}
        </p>
      </div>
      <Button variant="outline" href="/accounts/{accountId}/reconcile">Reconcile</Button>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Description>Current Balance</Card.Description>
          <Card.Title class="text-2xl">
            {#if filteredBalances.length === 0}
              {formatCurrency(0, settings.currency)}
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
                  is_strict: false,
                  include_subaccounts: false,
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
              <Table.Head class="hidden md:table-cell">Status</Table.Head>
              <Table.Head class="text-right">Amount</Table.Head>
              <Table.Head class="text-right hidden lg:table-cell">Running Balance</Table.Head>
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
                <Table.Cell class="hidden md:table-cell">
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
                <Table.Cell class="text-right font-mono text-muted-foreground hidden lg:table-cell">
                  {#each [...running.entries()] as [currency, amount]}
                    <span>{formatCurrency(amount, currency)}</span>
                  {/each}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
        <div class="p-4">
          <div class="flex items-center justify-between">
            <span class="text-sm text-muted-foreground">
              {journalStore.totalCount} total {journalStore.totalCount === 1 ? "transaction" : "transactions"}
            </span>
            <Pagination
              currentPage={journalStore.currentPage}
              totalPages={journalStore.totalPages}
              onPageChange={(p) => journalStore.loadPage(p)}
            />
          </div>
        </div>
      {/if}
    </Card.Root>
  {/if}
</div>
