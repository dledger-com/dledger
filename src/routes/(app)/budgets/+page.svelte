<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import type { Budget, Account } from "$lib/types/index.js";
  import Plus from "lucide-svelte/icons/plus";
  import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import * as m from "$paraglide/messages.js";

  type BudgetSortKey = "accountPattern" | "period" | "limit";
  const sort = createSortState<BudgetSortKey>();
  const budgetAccessors: Record<BudgetSortKey, (b: Budget) => string | number> = {
    accountPattern: (b) => b.account_pattern,
    period: (b) => b.period_type,
    limit: (b) => parseFloat(b.amount),
  };

  const settings = new SettingsStore();

  let budgets = $state<Budget[]>([]);
  let accounts = $state<Account[]>([]);
  let searchTerm = $state("");

  // Dialog state
  let addDialogOpen = $state(false);
  let editDialogOpen = $state(false);
  let editingBudget = $state<Budget | null>(null);

  // Shared form fields (used by both add and edit dialogs)
  let formPattern = $state("");
  let formPeriod = $state<"monthly" | "yearly">("monthly");
  let formAmount = $state("");
  let formCurrency = $state("");

  const filteredBudgets = $derived(
    budgets.filter((b) => matchesFilter(b, searchTerm.trim(), ["account_pattern", "currency", "period_type"]))
  );

  async function loadBudgets() {
    try {
      budgets = await getBackend().listBudgets();
    } catch (err) {
      toast.error(`Failed to load budgets: ${err}`);
    }
  }

  async function loadAccounts() {
    try {
      accounts = await getBackend().listAccounts();
    } catch {
      // ignore
    }
  }

  const expenseAccounts = $derived(
    accounts
      .filter((a) => a.full_name.startsWith("Expenses") && a.is_postable)
      .map((a) => a.full_name)
      .sort(),
  );

  function openAddDialog() {
    editingBudget = null;
    formPattern = "";
    formPeriod = "monthly";
    formAmount = "";
    formCurrency = settings.currency;
    addDialogOpen = true;
  }

  function openEditDialog(budget: Budget) {
    editingBudget = budget;
    formPattern = budget.account_pattern;
    formPeriod = budget.period_type;
    formAmount = budget.amount;
    formCurrency = budget.currency;
    editDialogOpen = true;
  }

  async function saveBudget() {
    if (!formPattern.trim() || !formAmount.trim()) {
      toast.error(m.error_pattern_amount_required());
      return;
    }
    try {
      if (editingBudget) {
        await getBackend().updateBudget({
          ...editingBudget,
          account_pattern: formPattern.trim(),
          period_type: formPeriod,
          amount: formAmount.trim(),
          currency: formCurrency || settings.currency,
        });
        editDialogOpen = false;
        toast.success(m.toast_budget_updated());
      } else {
        await getBackend().createBudget({
          id: uuidv7(),
          account_pattern: formPattern.trim(),
          period_type: formPeriod,
          amount: formAmount.trim(),
          currency: formCurrency || settings.currency,
          start_date: null,
          end_date: null,
          created_at: new Date().toISOString(),
        });
        addDialogOpen = false;
        toast.success(m.toast_budget_created());
      }
      await loadBudgets();
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(id: string) {
    try {
      await getBackend().deleteBudget(id);
      await loadBudgets();
      toast.success(m.toast_budget_deleted());
    } catch (err) {
      toast.error(String(err));
    }
  }

  // Lifecycle
  const unsubJournal = onInvalidate("journal", () => { loadBudgets(); });
  onDestroy(() => { unsubJournal(); clearTopBarActions(); });

  $effect(() => {
    setTopBarActions([
      { type: "button", label: m.btn_add(), onclick: openAddDialog, fab: true, fabIcon: Plus },
    ]);
  });

  onMount(() => {
    formCurrency = settings.currency;
    loadBudgets();
    loadAccounts();
  });
</script>

{#snippet budgetFormFields()}
  <div class="space-y-1">
    <label for="budget-pattern" class="text-xs text-muted-foreground">{m.label_account_pattern()}</label>
    <Input
      id="budget-pattern"
      placeholder="Expenses:Food"
      bind:value={formPattern}
      list="account-suggestions"
    />
    <datalist id="account-suggestions">
      {#each expenseAccounts as name}
        <option value={name}></option>
      {/each}
    </datalist>
    <p class="text-xs text-muted-foreground">{m.budget_pattern_hint()}</p>
  </div>
  <div class="grid grid-cols-2 gap-3">
    <div class="space-y-1">
      <label for="budget-period" class="text-xs text-muted-foreground">{m.label_period()}</label>
      <Select.Root type="single" bind:value={formPeriod}>
        <Select.Trigger class="w-full">
          {formPeriod === "monthly" ? m.option_monthly() : m.option_yearly()}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="monthly">{m.option_monthly()}</Select.Item>
          <Select.Item value="yearly">{m.option_yearly()}</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
    <div class="space-y-1">
      <label for="budget-amount" class="text-xs text-muted-foreground">{m.label_amount()}</label>
      <Input id="budget-amount" type="number" step="0.01" placeholder="500.00" bind:value={formAmount} />
    </div>
  </div>
  <div class="space-y-1">
    <label for="budget-currency" class="text-xs text-muted-foreground">{m.label_currency()}</label>
    <Input id="budget-currency" placeholder="USD" bind:value={formCurrency} />
  </div>
{/snippet}

{#snippet budgetActions(budget: Budget)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button variant="ghost" size="icon-sm" {...props}>
          <EllipsisVertical class="h-4 w-4" />
          <span class="sr-only">{m.label_actions()}</span>
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item onclick={() => openEditDialog(budget)}>{m.btn_edit()}</DropdownMenu.Item>
      <DropdownMenu.Item class="text-destructive" onclick={() => handleDelete(budget.id)}>{m.btn_delete()}</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

<div class="space-y-6">
  <div class="flex items-center gap-2">
    <ListFilter bind:value={searchTerm} placeholder={m.placeholder_filter_budgets()} class="min-w-0 w-[200px] lg:w-[250px] shrink" />
  </div>

  <!-- Add Budget Dialog -->
  <Dialog.Root bind:open={addDialogOpen}>
    <Dialog.Content class="max-w-sm">
      <Dialog.Header>
        <Dialog.Title>{m.section_add_budget()}</Dialog.Title>
      </Dialog.Header>
      <form onsubmit={(e) => { e.preventDefault(); saveBudget(); }} class="space-y-4">
        {@render budgetFormFields()}
        <Dialog.Footer>
          <Button type="submit" size="sm" disabled={!formPattern.trim() || !formAmount.trim()}>{m.btn_add()}</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>

  <!-- Edit Budget Dialog -->
  <Dialog.Root bind:open={editDialogOpen}>
    <Dialog.Content class="max-w-sm">
      <Dialog.Header>
        <Dialog.Title>{m.dialog_edit_budget()}</Dialog.Title>
      </Dialog.Header>
      <form onsubmit={(e) => { e.preventDefault(); saveBudget(); }} class="space-y-4">
        {@render budgetFormFields()}
        <Dialog.Footer>
          <Button type="submit" size="sm" disabled={!formPattern.trim() || !formAmount.trim()}>{m.btn_save()}</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>

  <!-- Budget Table -->
  {#if filteredBudgets.length > 0}
    <Card.Root class="border-x-0 rounded-none shadow-none py-0">
      <Card.Content class="p-0">
        <Table.Root>
          <Table.Header>
            <Table.Row class="hidden sm:table-row">
              <SortableHeader active={sort.key === "accountPattern"} direction={sort.direction} onclick={() => sort.toggle("accountPattern")}>{m.label_account_pattern()}</SortableHeader>
              <SortableHeader active={sort.key === "period"} direction={sort.direction} onclick={() => sort.toggle("period")}>{m.label_period()}</SortableHeader>
              <SortableHeader active={sort.key === "limit"} direction={sort.direction} onclick={() => sort.toggle("limit")} class="text-right">{m.label_limit()}</SortableHeader>
              <Table.Head class="text-right">{m.label_actions()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sorted = sort.key && sort.direction ? sortItems(filteredBudgets, budgetAccessors[sort.key], sort.direction) : filteredBudgets}
            {#each sorted as budget (budget.id)}
              <!-- Mobile row -->
              <Table.Row class="sm:hidden">
                <Table.Cell colspan={99} class="py-2 px-3">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-baseline justify-between gap-2">
                        <span class="font-mono text-sm truncate">{budget.account_pattern}</span>
                        <span class="font-mono text-sm text-right shrink-0 tabular-nums">
                          {budget.amount} {budget.currency}
                        </span>
                      </div>
                      <div class="flex items-baseline gap-x-1.5 mt-0.5 text-xs text-muted-foreground">
                        <Badge variant="secondary">{budget.period_type === "monthly" ? m.option_monthly() : m.option_yearly()}</Badge>
                      </div>
                    </div>
                    <div class="shrink-0">
                      {@render budgetActions(budget)}
                    </div>
                  </div>
                </Table.Cell>
              </Table.Row>
              <!-- Desktop row -->
              <Table.Row class="hidden sm:table-row">
                <Table.Cell class="font-mono text-sm">{budget.account_pattern}</Table.Cell>
                <Table.Cell>
                  <Badge variant="secondary">{budget.period_type === "monthly" ? m.option_monthly() : m.option_yearly()}</Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono">{budget.amount} {budget.currency}</Table.Cell>
                <Table.Cell class="text-right">
                  {@render budgetActions(budget)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {:else if budgets.length > 0 && searchTerm}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_budgets_match({ search: searchTerm })}
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.empty_no_budgets()}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
