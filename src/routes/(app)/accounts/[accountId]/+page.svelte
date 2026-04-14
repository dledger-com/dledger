<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { pushState, replaceState } from "$app/navigation";
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
  import { formatCurrency, negateCurrencyBalances } from "$lib/utils/format.js";
  import { filterHiddenEntries, filterHiddenBalances } from "$lib/utils/currency-filter.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { LineChart } from "layerchart";
  import { scaleTime, scaleLinear } from "d3-scale";
  import { v7 as uuidv7 } from "uuid";
  import { toast } from "svelte-sonner";
  import { ExchangeRateCache } from "$lib/utils/exchange-rate-cache.js";
  import { monthEndDates } from "$lib/utils/balance-history.js";
  import type { Account, CurrencyBalance, JournalEntry, LineItem, BalanceAssertion } from "$lib/types/index.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
  import { DEMO_MODE } from "$lib/demo.js";
  import { setBreadcrumbOverride, clearBreadcrumbOverride } from "$lib/data/breadcrumb.svelte.js";
  import * as m from "$paraglide/messages.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import JournalEntryDrawer from "$lib/components/JournalEntryDrawer.svelte";
  import JournalEntryDialog from "$lib/components/JournalEntryDialog.svelte";

  type AssertionSortKey = "date" | "currency" | "expected" | "actual" | "status";
  const assertionSort = createSortState<AssertionSortKey>();
  const assertionAccessors: Record<AssertionSortKey, (a: BalanceAssertion) => string | number | null> = {
    date: (a) => a.date,
    currency: (a) => a.currency,
    expected: (a) => parseFloat(a.expected_balance),
    actual: (a) => a.actual_balance ? parseFloat(a.actual_balance) : null,
    status: (a) => a.is_passing ? 1 : 0,
  };

  type TxSortKey = "date" | "description" | "amount";
  const txSort = createSortState<TxSortKey>();

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
  let searchTerm = $state("");

  // Entry drawer / edit dialog state
  let drawerOpen = $state(false);
  let drawerEntryId = $state<string | null>(null);
  let dialogOpen = $state(false);
  let dialogEntryId = $state<string | null>(null);

  function openEntryDrawer(entryId: string) {
    drawerEntryId = entryId;
    drawerOpen = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("entry") !== entryId) {
      url.searchParams.set("entry", entryId);
      pushState(url, {});
    }
  }

  function closeEntryDrawer() {
    drawerOpen = false;
    drawerEntryId = null;
    const url = new URL(window.location.href);
    if (url.searchParams.has("entry")) {
      url.searchParams.delete("entry");
      replaceState(url, {});
    }
  }

  function handleDrawerPopstate() {
    const id = new URL(window.location.href).searchParams.get("entry");
    if (id && !drawerOpen) {
      drawerEntryId = id;
      drawerOpen = true;
    } else if (!id && drawerOpen) {
      drawerOpen = false;
      drawerEntryId = null;
    }
  }

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

  // Filter entries by search term
  const filteredEntriesWithRunning = $derived.by(() => {
    if (!searchTerm) return entriesWithRunning;
    const lower = searchTerm.toLowerCase();
    return entriesWithRunning.filter(({ entry: [e] }) =>
      e.description.toLowerCase().includes(lower) || e.date.includes(lower)
    );
  });

  // Sort filtered entries
  const sortedFilteredEntries = $derived.by(() => {
    if (!txSort.key || !txSort.direction) return filteredEntriesWithRunning;
    const accessors: Record<TxSortKey, (item: typeof filteredEntriesWithRunning[0]) => string | number | null> = {
      date: (r) => r.entry[0].date,
      description: (r) => r.entry[0].description,
      amount: (r) => {
        const items = r.entry[1].filter((i: LineItem) => i.account_id === accountId);
        return items.length > 0 ? parseFloat(items[0].amount) : 0;
      },
    };
    return sortItems(filteredEntriesWithRunning, accessors[txSort.key], txSort.direction);
  });

  // Virtual scrolling for transaction history
  let txScrollEl = $state<HTMLDivElement | null>(null);

  const txVirtualizer = createVirtualizer(() => ({
    count: sortedFilteredEntries.length,
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

      // Find date range and generate sample dates
      const first = new Date(snapshots[0].date);
      const last = new Date();
      const sampleDates = monthEndDates(first, last);

      const points: { date: Date; value: number }[] = [];
      const rateCache = new ExchangeRateCache(getBackend());
      const baseCurrency = settings.currency;

      for (const dateStr of sampleDates) {
        // Find the last snapshot on or before this date
        let balAtDate: Map<string, number> | null = null;
        for (let i = snapshots.length - 1; i >= 0; i--) {
          if (snapshots[i].date <= dateStr) {
            balAtDate = snapshots[i].balances;
            break;
          }
        }

        let total = 0;
        if (balAtDate) {
          for (const [currency, amount] of balAtDate) {
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
      }
      balanceChartData = points;
    } catch (e) {
      console.error("Balance chart failed:", e);
    } finally {
      chartLoading = false;
    }
  }

  async function reloadData() {
    const id = accountId;
    if (!id) return;
    const [, balResult, , assertResult] = await Promise.all([
      accountStore.load(),
      accountStore.getBalance(id),
      journalStore.load({ account_id: id }),
      getBackend().listBalanceAssertions(id).catch(() => [] as BalanceAssertion[]),
    ]);
    await journalStore.loadAllLineItems();
    account = accountStore.byId.get(id) ?? null;
    balances = balResult;
    assertions = assertResult;
    if (account) loadBalanceChart(id, journalStore.withItems);
  }

  onMount(async () => {
    loading = true;
    await reloadData();
    loading = false;

    const entryIdFromUrl = new URL(window.location.href).searchParams.get("entry");
    if (entryIdFromUrl) {
      drawerEntryId = entryIdFromUrl;
      drawerOpen = true;
    }
    window.addEventListener("popstate", handleDrawerPopstate);
  });

  $effect(() => {
    if (account) {
      setBreadcrumbOverride(accountId!, account.full_name);
      setTopBarActions(
        DEMO_MODE
          ? []
          : [
              { type: 'button', label: m.btn_reconcile(), href: `/accounts/${accountId}/reconcile`, variant: 'outline' }
            ],
      );
    }
  });

  const unsubJournal = onInvalidate("journal", async () => { await reloadData(); });
  const unsubAccounts = onInvalidate("accounts", async () => { await reloadData(); });

  onDestroy(() => {
    if (accountId) clearBreadcrumbOverride(accountId);
    clearTopBarActions();
    unsubJournal();
    unsubAccounts();
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", handleDrawerPopstate);
    }
  });
</script>

<svelte:head><title>{account?.full_name ?? "Account"} · dLedger</title></svelte:head>

<div class="space-y-6">
  {#if loading}
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  {:else if !account}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">{m.error_account_not_found()}</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <p class="text-muted-foreground flex items-center gap-2">
      <AccountTypeBadge type={account.account_type} />
      {#if account.is_archived}
        <Badge variant="destructive">{m.state_archived()}</Badge>
      {/if}
      {#if editingOpenedAt}
        <span class="text-xs">{m.label_opened()}</span>
        <Input type="date" class="w-36 h-7 text-xs" bind:value={openedAtValue} />
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={async () => {
          try {
            await getBackend().updateAccount(accountId!, { opened_at: openedAtValue || null });
            account = { ...account!, opened_at: openedAtValue || null };
            editingOpenedAt = false;
            toast.success(m.toast_opened_date_updated());
          } catch (e) { toast.error(String(e)); }
        }}>{m.btn_save()}</Button>
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={() => { editingOpenedAt = false; }}>{m.btn_cancel()}</Button>
      {:else}
        <button class="text-xs hover:underline cursor-pointer" onclick={() => { openedAtValue = account!.opened_at ?? account!.created_at; editingOpenedAt = true; }}>
          {m.label_opened()} {account.opened_at ?? account.created_at}
        </button>
      {/if}
    </p>

    <div class="grid gap-4 sm:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Description>{m.label_current_balance()}</Card.Description>
          <Card.Title class="text-2xl">
            {#if filteredBalances.length === 0}
              {formatCurrency(0, settings.currency)}
            {:else}
              {@const displayBalances = account && ["liability", "equity", "revenue"].includes(account.account_type) ? negateCurrencyBalances(filteredBalances) : filteredBalances}
              {displayBalances.map((b) => formatCurrency(b.amount, b.currency)).join(", ")}
            {/if}
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>{m.label_transactions()}</Card.Description>
          <Card.Title class="text-2xl">{filteredEntries.length}</Card.Title>
        </Card.Header>
      </Card.Root>
    </div>

    <!-- Balance Assertions -->
    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <div>
          <Card.Title>{m.section_balance_assertions()}</Card.Title>
          <Card.Description class="mt-1">{m.desc_balance_assertions()}</Card.Description>
        </div>
        <Button variant="outline" size="sm" onclick={() => { showAssertionForm = !showAssertionForm; }}>
          {showAssertionForm ? m.btn_cancel() : m.btn_add_assertion()}
        </Button>
      </Card.Header>
      <Card.Content>
        {#if showAssertionForm}
          <div class="flex items-end gap-3 mb-4 p-3 rounded-md border bg-muted/30">
            <div class="space-y-1">
              <label for="assert-date" class="text-xs font-medium">{m.label_date()}</label>
              <Input id="assert-date" type="date" bind:value={assertionDate} class="w-36 h-8 text-sm" />
            </div>
            <div class="space-y-1">
              <label for="assert-currency" class="text-xs font-medium">{m.label_currency()}</label>
              <Input id="assert-currency" type="text" placeholder="USD" bind:value={assertionCurrency} class="w-20 h-8 text-sm" />
            </div>
            <div class="space-y-1">
              <label for="assert-amount" class="text-xs font-medium">{m.label_expected_balance()}</label>
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
                toast.success(m.toast_assertion_created());
              } catch (e) {
                toast.error(String(e));
              }
            }}>{m.btn_save()}</Button>
          </div>
        {/if}
        {#if assertions.length === 0 && !showAssertionForm}
          <EmptyState message={m.empty_no_assertions()} />
        {:else if assertions.length > 0}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <SortableHeader active={assertionSort.key === "date"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("date")}>{m.label_date()}</SortableHeader>
                <SortableHeader active={assertionSort.key === "currency"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("currency")}>{m.label_currency()}</SortableHeader>
                <SortableHeader active={assertionSort.key === "expected"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("expected")} class="text-right">{m.label_expected_balance()}</SortableHeader>
                <SortableHeader active={assertionSort.key === "actual"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("actual")} class="text-right">{m.label_actual()}</SortableHeader>
                <SortableHeader active={assertionSort.key === "status"} direction={assertionSort.direction} onclick={() => assertionSort.toggle("status")}>{m.label_status()}</SortableHeader>
                <Table.Head>{m.label_actions()}</Table.Head>
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
                      <Badge variant="default" class="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">{m.state_pass()}</Badge>
                    {:else}
                      <Badge variant="destructive">{m.state_fail()}</Badge>
                    {/if}
                  </Table.Cell>
                  <Table.Cell>
                    {#if !a.is_passing && !DEMO_MODE}
                      <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => {
                        paddingAssertionId = paddingAssertionId === a.id ? null : a.id;
                        padCounterparty = "Equity:Opening-Balances";
                        const d = new Date(a.date + "T00:00:00"); d.setDate(d.getDate() - 1); padDate = d.toISOString().slice(0, 10);
                      }}>
                        {paddingAssertionId === a.id ? m.btn_cancel() : m.btn_pad()}
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
                          <label class="text-xs font-medium">{m.label_counterparty_account()}</label>
                          <Input type="text" bind:value={padCounterparty} class="w-64 h-8 text-sm" />
                        </div>
                        <div class="space-y-1">
                          <label class="text-xs font-medium">{m.label_date()}</label>
                          <Input type="date" bind:value={padDate} class="w-40 h-8 text-sm" />
                        </div>
                        <div class="space-y-1">
                          <label class="text-xs font-medium">{m.label_amount()}</label>
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
                            toast.success(m.toast_pad_entry_created());
                          } catch (e) {
                            toast.error(String(e));
                          }
                        }}>{m.btn_create_pad()}</Button>
                        <Button variant="ghost" size="sm" onclick={() => { paddingAssertionId = null; }}>{m.btn_cancel()}</Button>
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
        <Card.Title>{m.chart_balance_over_time()}</Card.Title>
      </Card.Header>
      <Card.Content>
        {#if chartLoading}
          <Skeleton class="h-40 w-full" />
        {:else if balanceChartData.length < 2}
          <EmptyState message={m.empty_not_enough_chart_data()} />
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
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <Card.Title>{m.section_transaction_history()}</Card.Title>
        <ListFilter bind:value={searchTerm} placeholder={m.placeholder_filter_entries()} />
      </Card.Header>
      {#if filteredEntries.length === 0}
        <Card.Content>
          <EmptyState message={m.empty_no_transactions()} />
        </Card.Content>
      {:else}
        <div bind:this={txScrollEl} class="overflow-y-auto max-h-[calc(100vh-220px)]">
          <Table.Root>
            <Table.Header class="sticky top-0 z-10 bg-background">
              <Table.Row>
                <SortableHeader active={txSort.key === "date"} direction={txSort.direction} onclick={() => txSort.toggle("date")}>{m.label_date()}</SortableHeader>
                <SortableHeader active={txSort.key === "description"} direction={txSort.direction} onclick={() => txSort.toggle("description")}>{m.label_description()}</SortableHeader>
                <Table.Head class="hidden md:table-cell">{m.label_status()}</Table.Head>
                <SortableHeader active={txSort.key === "amount"} direction={txSort.direction} onclick={() => txSort.toggle("amount")} class="text-right">{m.label_amount()}</SortableHeader>
                <Table.Head class="text-right hidden lg:table-cell">{m.label_running_balance()}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#if txPaddingTop > 0}
                <tr><td style="height: {txPaddingTop}px;" colspan="5"></td></tr>
              {/if}
              {#each txVirtualItems as row (row.key)}
                {@const { entry: [entry, items], running } = sortedFilteredEntries[row.index]}
                {@const relevantItems = items.filter((i: LineItem) => i.account_id === accountId)}
                <Table.Row class="cursor-pointer" onclick={() => openEntryDrawer(entry.id)}>
                  <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
                  <Table.Cell>
                    <span>{entry.description}</span>
                  </Table.Cell>
                  <Table.Cell class="hidden md:table-cell">
                    <Badge variant={entry.status === "confirmed" ? "default" : "secondary"}>
                      {entry.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">
                    {#each relevantItems as item}
                      {@const amt = parseFloat(item.amount)}
                      <span class={amt >= 0 ? "" : "text-negative"}>
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
            {journalStore.totalCount} {m.label_transactions()}
          </span>
        </div>
      {/if}
    </Card.Root>
  {/if}
</div>

<JournalEntryDrawer
  bind:open={drawerOpen}
  bind:entryId={drawerEntryId}
  onedit={() => { drawerOpen = false; dialogEntryId = drawerEntryId; dialogOpen = true; }}
  onclose={closeEntryDrawer}
  onsaved={(newId) => {
    drawerEntryId = newId;
    const url = new URL(window.location.href);
    url.searchParams.set("entry", newId);
    replaceState(url, {});
  }}
/>

<JournalEntryDialog
  bind:open={dialogOpen}
  mode="edit"
  bind:entryId={dialogEntryId}
  onsaved={(newId) => { dialogOpen = false; openEntryDrawer(newId); }}
  onclose={() => { dialogOpen = false; }}
/>
