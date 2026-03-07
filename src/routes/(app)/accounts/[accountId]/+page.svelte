<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
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
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";

  type AssertionSortKey = "date" | "currency" | "expected" | "actual" | "status";
  const assertionSort = createSortState<AssertionSortKey>();
  const assertionAccessors: Record<AssertionSortKey, (a: BalanceAssertion) => string | number | null> = {
    date: (a) => a.date,
    currency: (a) => a.currency,
    expected: (a) => parseFloat(a.expected_balance),
    actual: (a) => a.actual_balance ? parseFloat(a.actual_balance) : null,
    status: (a) => a.is_passing ? 1 : 0,
  };

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
  let paddingAssertionId = $state<string | null>(null);
  let padCounterparty = $state("Equity:Opening-Balances");
  let padDate = $state("");
  let editingOpenedAt = $state(false);
  let openedAtValue = $state("");
  const hidden = $derived(settings.showHidden ? new Set<string>() : getHiddenCurrencySet());
  const filteredEntries = $derived(filterHiddenEntries(journalStore.withItems, hidden));
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

  // Virtual scrolling for transaction history
  let txScrollEl = $state<HTMLDivElement | null>(null);

  const txVirtualizer = createVirtualizer(() => ({
    count: entriesWithRunning.length,
    getScrollElement: () => txScrollEl,
    estimateSize: () => 44,
    overscan: 10,
  }));

  const txVirtualItems = $derived(txVirtualizer.getVirtualItems());
  const txTotalSize = $derived(txVirtualizer.getTotalSize());
  const txPaddingTop = $derived(txVirtualItems.length > 0 ? txVirtualItems[0].start : 0);
  const txPaddingBottom = $derived(
    txVirtualItems.length > 0 ? txTotalSize - txVirtualItems[txVirtualItems.length - 1].end : 0
  );

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
    // Account page has small datasets — load all line items eagerly
    await journalStore.loadAllLineItems();
    account = accountStore.byId.get(id) ?? null;
    balances = balResult;
    assertions = assertResult;
    if (account) loadBalanceChart(id, journalStore.withItems);
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
          <AccountTypeBadge type={account.account_type} />
          {#if account.is_archived}
            <Badge variant="destructive">Archived</Badge>
          {/if}
          {#if editingOpenedAt}
            <span class="text-xs">Opened:</span>
            <Input type="date" class="w-36 h-7 text-xs" bind:value={openedAtValue} />
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={async () => {
              try {
                await getBackend().updateAccount(accountId!, { opened_at: openedAtValue || null });
                account = { ...account!, opened_at: openedAtValue || null };
                editingOpenedAt = false;
                toast.success("Opened date updated");
              } catch (e) { toast.error(String(e)); }
            }}>Save</Button>
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={() => { editingOpenedAt = false; }}>Cancel</Button>
          {:else}
            <button class="text-xs hover:underline cursor-pointer" onclick={() => { openedAtValue = account!.opened_at ?? account!.created_at; editingOpenedAt = true; }}>
              Opened: {account.opened_at ?? account.created_at}
            </button>
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
                <SortableHeader active={assertionSort.key === "date"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("date")}>Date</SortableHeader>
                <SortableHeader active={assertionSort.key === "currency"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("currency")}>Currency</SortableHeader>
                <SortableHeader active={assertionSort.key === "expected"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("expected")} class="text-right">Expected</SortableHeader>
                <SortableHeader active={assertionSort.key === "actual"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("actual")} class="text-right">Actual</SortableHeader>
                <SortableHeader active={assertionSort.key === "status"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("status")}>Status</SortableHeader>
                <Table.Head>Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {@const sortedAssertions = assertionSort.key && assertionSort.direction ? sortItems(assertions, assertionAccessors[assertionSort.key], assertionSort.direction) : assertions}
              {#each sortedAssertions as a (a.id)}
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
                  <Table.Cell>
                    {#if !a.is_passing}
                      <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => {
                        paddingAssertionId = paddingAssertionId === a.id ? null : a.id;
                        padCounterparty = "Equity:Opening-Balances";
                        const d = new Date(a.date + "T00:00:00"); d.setDate(d.getDate() - 1); padDate = d.toISOString().slice(0, 10);
                      }}>
                        {paddingAssertionId === a.id ? "Cancel" : "Pad"}
                      </Button>
                    {/if}
                  </Table.Cell>
                </Table.Row>
                {#if paddingAssertionId === a.id}
                  {@const diff = parseFloat(a.expected_balance) - parseFloat(a.actual_balance ?? "0")}

                  <Table.Row>
                    <Table.Cell colspan={6}>
                      <div class="flex items-end gap-3 p-3 rounded-md border bg-muted/30">
                        <div class="space-y-1">
                          <label class="text-xs font-medium">Counterparty Account</label>
                          <Input type="text" bind:value={padCounterparty} class="w-64 h-8 text-sm" />
                        </div>
                        <div class="space-y-1">
                          <label class="text-xs font-medium">Date</label>
                          <Input type="date" bind:value={padDate} class="w-40 h-8 text-sm" />
                        </div>
                        <div class="space-y-1">
                          <label class="text-xs font-medium">Amount</label>
                          <span class="text-sm font-mono block h-8 leading-8">{diff > 0 ? "+" : ""}{diff.toFixed(2)} {a.currency}</span>
                        </div>
                        <Button size="sm" onclick={async () => {
                          try {
                            const backend = getBackend();
                            // Ensure counterparty account exists
                            const allAccounts = await backend.listAccounts();
                            let counterpartyId = allAccounts.find((ac) => ac.full_name === padCounterparty)?.id;
                            if (!counterpartyId) {
                              // Create counterparty account hierarchy
                              const parts = padCounterparty.split(":");
                              let parentId: string | null = null;
                              for (let depth = 1; depth <= parts.length; depth++) {
                                const path = parts.slice(0, depth).join(":");
                                const existing = allAccounts.find((ac) => ac.full_name === path);
                                if (existing) {
                                  parentId = existing.id;
                                  continue;
                                }
                                const type = path.startsWith("Equity") ? "equity" : path.startsWith("Assets") ? "asset" : path.startsWith("Liabilities") ? "liability" : path.startsWith("Income") ? "revenue" : "expense";
                                const newId = uuidv7();
                                await backend.createAccount({
                                  id: newId, parent_id: parentId, account_type: type,
                                  name: parts[depth - 1], full_name: path, allowed_currencies: [],
                                  is_postable: depth === parts.length, is_archived: false,
                                  created_at: padDate, opened_at: null,
                                });
                                parentId = newId;
                                if (depth === parts.length) counterpartyId = newId;
                              }
                            }
                            // Create pad journal entry
                            const entryId = uuidv7();
                            const diffStr = diff.toString();
                            await backend.postJournalEntry(
                              { id: entryId, date: padDate, description: `Pad for ${account!.full_name}`, status: "confirmed", source: "system:pad", voided_by: null, created_at: padDate },
                              [
                                { id: uuidv7(), journal_entry_id: entryId, account_id: accountId!, currency: a.currency, amount: diffStr, lot_id: null },
                                { id: uuidv7(), journal_entry_id: entryId, account_id: counterpartyId!, currency: a.currency, amount: (-diff).toString(), lot_id: null },
                              ],
                            );
                            // Re-check assertions
                            await backend.checkBalanceAssertions();
                            assertions = await backend.listBalanceAssertions(accountId!);
                            balances = await accountStore.getBalance(accountId!);
                            await journalStore.load({ account_id: accountId! });
                            await journalStore.loadAllLineItems();
                            paddingAssertionId = null;
                            const { invalidate } = await import("$lib/data/invalidation.js");
                            invalidate("journal", "accounts", "reports");
                            toast.success("Pad entry created");
                          } catch (e) {
                            toast.error(String(e));
                          }
                        }}>Create Pad</Button>
                        <Button variant="ghost" size="sm" onclick={() => { paddingAssertionId = null; }}>Cancel</Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                {/if}
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
        <div bind:this={txScrollEl} class="overflow-y-auto max-h-[calc(100vh-220px)]">
          <Table.Root>
            <Table.Header class="sticky top-0 z-10 bg-background">
              <Table.Row>
                <Table.Head>Date</Table.Head>
                <Table.Head>Description</Table.Head>
                <Table.Head class="hidden md:table-cell">Status</Table.Head>
                <Table.Head class="text-right">Amount</Table.Head>
                <Table.Head class="text-right hidden lg:table-cell">Running Balance</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#if txPaddingTop > 0}
                <tr><td style="height: {txPaddingTop}px;" colspan="5"></td></tr>
              {/if}
              {#each txVirtualItems as row (row.key)}
                {@const { entry: [entry, items], running } = entriesWithRunning[row.index]}
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
              {#if txPaddingBottom > 0}
                <tr><td style="height: {txPaddingBottom}px;" colspan="5"></td></tr>
              {/if}
            </Table.Body>
          </Table.Root>
        </div>
        <div class="p-4">
          <span class="text-sm text-muted-foreground">
            {journalStore.totalCount} total {journalStore.totalCount === 1 ? "transaction" : "transactions"}
          </span>
        </div>
      {/if}
    </Card.Root>
  {/if}
</div>
