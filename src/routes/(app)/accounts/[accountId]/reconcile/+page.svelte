<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { pushState, replaceState } from "$app/navigation";
  import * as m from "$paraglide/messages.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { getBackend, type Reconciliation, type UnreconciledLineItem } from "$lib/backend.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
  import { computeDifference, isDifferenceZero } from "$lib/utils/reconciliation.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import type { Account, CurrencyBalance } from "$lib/types/index.js";
  import { setBreadcrumbOverride, clearBreadcrumbOverride } from "$lib/data/breadcrumb.svelte.js";
  import JournalEntryDrawer from "$lib/components/JournalEntryDrawer.svelte";
  import JournalEntryDialog from "$lib/components/JournalEntryDialog.svelte";

  const accountId = $derived(page.params.accountId);
  let account = $state<Account | null>(null);
  let balances = $state<CurrencyBalance[]>([]);
  let loading = $state(true);

  // Reconciliation form
  let currency = $state("");
  let statementDate = $state(new Date().toISOString().slice(0, 10));
  let statementBalance = $state("");
  let items = $state<UnreconciledLineItem[]>([]);
  let selectedIds = $state<Set<string>>(new Set());
  let itemsLoaded = $state(false);
  let reconciling = $state(false);

  // History
  let reconciliations = $state<Reconciliation[]>([]);

  // Sort state for reconciliation history
  type RecSortKey = "statementDate" | "currency" | "balance" | "items" | "reconciled";
  const sortRec = createSortState<RecSortKey>();
  const recAccessors: Record<RecSortKey, SortAccessor<Reconciliation>> = {
    statementDate: (r) => r.statement_date,
    currency: (r) => r.currency,
    balance: (r) => parseFloat(r.statement_balance),
    items: (r) => r.line_item_count,
    reconciled: (r) => r.reconciled_at,
  };

  // Existing reconciled balance for this account+currency
  let existingBalance = $state("0");

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

  const difference = $derived(
    statementBalance && items.length > 0
      ? computeDifference(statementBalance, items, selectedIds, existingBalance)
      : ""
  );
  const canReconcile = $derived(
    statementBalance && items.length > 0 && selectedIds.size > 0 &&
    isDifferenceZero(statementBalance, items, selectedIds, existingBalance)
  );

  function toggleItem(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
  }

  function selectAll() {
    selectedIds = new Set(items.map(i => i.line_item_id));
  }

  function selectNone() {
    selectedIds = new Set();
  }

  async function loadItems() {
    if (!currency || !accountId) return;
    itemsLoaded = false;
    try {
      items = await getBackend().getUnreconciledLineItems(accountId, currency, statementDate || undefined);
      selectedIds = new Set();

      // Compute existing reconciled balance
      const allBalance = await getBackend().getAccountBalance(accountId, statementDate || undefined);
      const bal = allBalance.find(b => b.currency === currency);
      const totalBal = bal ? parseFloat(bal.amount) : 0;
      const unreconciledTotal = items.reduce((sum, i) => sum + parseFloat(i.amount), 0);
      existingBalance = (totalBal - unreconciledTotal).toString();
    } catch (e) {
      toast.error(String(e));
    } finally {
      itemsLoaded = true;
    }
  }

  async function handleReconcile() {
    if (!canReconcile || !accountId) return;
    reconciling = true;
    try {
      const rec: Reconciliation = {
        id: uuidv7(),
        account_id: accountId!,
        statement_date: statementDate,
        statement_balance: statementBalance,
        currency,
        reconciled_at: new Date().toISOString().slice(0, 10),
        line_item_count: selectedIds.size,
      };
      await getBackend().markReconciled(rec, [...selectedIds]);
      toast.success(m.toast_items_reconciled({ count: String(selectedIds.size) }));
      await loadItems();
      reconciliations = await getBackend().listReconciliations(accountId!);
    } catch (e) {
      toast.error(String(e));
    } finally {
      reconciling = false;
    }
  }

  onMount(async () => {
    if (!accountId) { loading = false; return; }
    try {
      account = await getBackend().getAccount(accountId);
      balances = await getBackend().getAccountBalance(accountId);
      reconciliations = await getBackend().listReconciliations(accountId);
      // Default currency to first balance currency
      if (balances.length > 0) {
        currency = balances[0].currency;
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      loading = false;
    }

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
    }
  });

  const unsubJournal = onInvalidate("journal", async () => {
    if (accountId) {
      reconciliations = await getBackend().listReconciliations(accountId);
      if (itemsLoaded) await loadItems();
    }
  });

  onDestroy(() => {
    if (accountId) clearBreadcrumbOverride(accountId);
    unsubJournal();
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", handleDrawerPopstate);
    }
  });
</script>

<svelte:head><title>Reconcile · dLedger</title></svelte:head>

<div class="space-y-6">
  {#if loading}
    <Skeleton class="h-10 w-64" />
  {:else if !account}
    <Card.Root>
      <Card.Content class="py-8">
        <EmptyState message={m.error_account_not_found()} />
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Setup -->
    <Card.Root>
      <Card.Header>
        <Card.Title>{m.section_statement_details()}</Card.Title>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-wrap items-end gap-3">
          <div class="space-y-1">
            <label for="rec-currency" class="text-xs font-medium">{m.label_currency()}</label>
            <Select.Root type="single" bind:value={currency}>
              <Select.Trigger class="w-28">
                {currency}
              </Select.Trigger>
              <Select.Content>
                {#each balances as b (b.currency)}
                  <Select.Item value={b.currency}>{b.currency}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="space-y-1">
            <label for="rec-date" class="text-xs font-medium">{m.label_statement_date()}</label>
            <Input id="rec-date" type="date" bind:value={statementDate} class="w-40" />
          </div>
          <div class="space-y-1">
            <label for="rec-balance" class="text-xs font-medium">{m.label_statement_balance()}</label>
            <Input id="rec-balance" type="text" placeholder="0.00" bind:value={statementBalance} class="w-36" />
          </div>
          <Button size="sm" onclick={loadItems}>{m.btn_load_items()}</Button>
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Unreconciled Items -->
    {#if itemsLoaded}
      <Card.Root>
        <Card.Header>
          <div class="flex items-center justify-between">
            <div>
              <Card.Title>{m.section_unreconciled_items({ count: String(items.length) })}</Card.Title>
              <Card.Description>{m.desc_unreconciled_items()}</Card.Description>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={selectAll}>{m.btn_select_all()}</Button>
              <Button variant="outline" size="sm" onclick={selectNone}>{m.btn_clear()}</Button>
            </div>
          </div>
        </Card.Header>
        {#if items.length === 0}
          <Card.Content>
            <EmptyState message={m.empty_all_reconciled()} />
          </Card.Content>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head class="w-10"></Table.Head>
                <Table.Head>{m.label_date()}</Table.Head>
                <Table.Head>{m.label_description()}</Table.Head>
                <Table.Head class="text-right">{m.label_amount()}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each items as item (item.line_item_id)}
                {@const checked = selectedIds.has(item.line_item_id)}
                <Table.Row class={checked ? "bg-primary/5" : ""}>
                  <Table.Cell>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleItem(item.line_item_id)}
                    />
                  </Table.Cell>
                  <Table.Cell class="text-muted-foreground">{item.entry_date}</Table.Cell>
                  <Table.Cell>
                    <button type="button" class="hover:underline text-left bg-transparent border-0 p-0 cursor-pointer" onclick={() => openEntryDrawer(item.entry_id)}>{item.entry_description}</button>
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">
                    {@const amt = parseFloat(item.amount)}
                    <span class={amt < 0 ? "text-negative" : ""}>
                      {formatCurrency(amt, item.currency)}
                    </span>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>

          <Card.Content>
            <div class="flex items-center justify-between">
              <div class="space-y-1">
                <p class="text-sm">
                  {m.label_selected()} <span class="font-mono font-medium">{selectedIds.size}</span> {m.label_items()}
                </p>
                {#if difference}
                  <p class="text-sm">
                    {m.label_difference()} <span class="font-mono font-medium {parseFloat(difference) === 0 ? 'text-positive' : 'text-orange-600 dark:text-orange-400'}">
                      {formatCurrency(difference, currency)}
                    </span>
                  </p>
                {/if}
              </div>
              <Button
                disabled={!canReconcile || reconciling}
                onclick={handleReconcile}
              >
                {reconciling ? m.state_reconciling() : m.btn_mark_reconciled()}
              </Button>
            </div>
          </Card.Content>
        {/if}
      </Card.Root>
    {/if}

    <!-- Reconciliation History -->
    {#if reconciliations.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>{m.section_reconciliation_history()}</Card.Title>
        </Card.Header>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortRec.key === "statementDate"} direction={sortRec.direction} onclick={() => sortRec.toggle("statementDate")}>{m.label_statement_date()}</SortableHeader>
              <SortableHeader active={sortRec.key === "currency"} direction={sortRec.direction} onclick={() => sortRec.toggle("currency")}>{m.label_currency()}</SortableHeader>
              <SortableHeader active={sortRec.key === "balance"} direction={sortRec.direction} onclick={() => sortRec.toggle("balance")} class="text-right">{m.label_balance()}</SortableHeader>
              <SortableHeader active={sortRec.key === "items"} direction={sortRec.direction} onclick={() => sortRec.toggle("items")} class="text-right">{m.label_items()}</SortableHeader>
              <SortableHeader active={sortRec.key === "reconciled"} direction={sortRec.direction} onclick={() => sortRec.toggle("reconciled")}>{m.label_date()}</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedReconciliations = sortRec.key && sortRec.direction ? sortItems(reconciliations, recAccessors[sortRec.key], sortRec.direction) : reconciliations}
            {#each sortedReconciliations as rec (rec.id)}
              <Table.Row>
                <Table.Cell>{rec.statement_date}</Table.Cell>
                <Table.Cell>{rec.currency}</Table.Cell>
                <Table.Cell class="text-right font-mono">{formatCurrency(rec.statement_balance, rec.currency)}</Table.Cell>
                <Table.Cell class="text-right">{rec.line_item_count}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{rec.reconciled_at}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Root>
    {/if}
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
