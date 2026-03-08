<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import type { Budget, Account } from "$lib/types/index.js";
  import Plus from "lucide-svelte/icons/plus";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";

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

  // New budget form
  let newPattern = $state("");
  let newPeriod = $state<"monthly" | "yearly">("monthly");
  let newAmount = $state("");
  let newCurrency = $state("");
  let adding = $state(false);

  let searchTerm = $state("");
  const filteredBudgets = $derived(
    budgets.filter((b) => matchesFilter(b, searchTerm.trim(), ["account_pattern", "currency", "period_type"]))
  );

  // Edit state
  let editingId = $state<string | null>(null);
  let editPattern = $state("");
  let editPeriod = $state<"monthly" | "yearly">("monthly");
  let editAmount = $state("");

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

  onMount(() => {
    newCurrency = settings.currency;
    loadBudgets();
    loadAccounts();
  });

  const expenseAccounts = $derived(
    accounts
      .filter((a) => a.full_name.startsWith("Expenses") && a.is_postable)
      .map((a) => a.full_name)
      .sort(),
  );

  async function handleAdd() {
    if (!newPattern.trim() || !String(newAmount).trim()) {
      toast.error("Account pattern and amount are required");
      return;
    }
    adding = true;
    try {
      await getBackend().createBudget({
        id: uuidv7(),
        account_pattern: newPattern.trim(),
        period_type: newPeriod,
        amount: String(newAmount).trim(),
        currency: newCurrency || settings.currency,
        start_date: null,
        end_date: null,
        created_at: new Date().toISOString(),
      });
      newPattern = "";
      newAmount = "";
      await loadBudgets();
      toast.success("Budget created");
    } catch (err) {
      toast.error(String(err));
    } finally {
      adding = false;
    }
  }

  function startEdit(budget: Budget) {
    editingId = budget.id;
    editPattern = budget.account_pattern;
    editPeriod = budget.period_type;
    editAmount = budget.amount;
  }

  async function saveEdit(budget: Budget) {
    try {
      await getBackend().updateBudget({
        ...budget,
        account_pattern: editPattern,
        period_type: editPeriod,
        amount: editAmount,
      });
      editingId = null;
      await loadBudgets();
      toast.success("Budget updated");
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleDelete(id: string) {
    try {
      await getBackend().deleteBudget(id);
      await loadBudgets();
      toast.success("Budget deleted");
    } catch (err) {
      toast.error(String(err));
    }
  }
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <ListFilter bind:value={searchTerm} placeholder="Filter budgets..." />
  </div>

  <!-- Add Budget -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Add Budget</Card.Title>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="space-y-1">
      <div class="flex items-end gap-3 flex-wrap">
        <div class="flex-1 min-w-[200px] space-y-1">
          <label for="budget-pattern" class="text-xs font-medium">Account Pattern</label>
          <Input
            id="budget-pattern"
            placeholder="Expenses:Food"
            bind:value={newPattern}
            list="account-suggestions"
          />
          <datalist id="account-suggestions">
            {#each expenseAccounts as name}
              <option value={name}></option>
            {/each}
          </datalist>
        </div>
        <div class="space-y-1 w-28">
          <label for="budget-period" class="text-xs font-medium">Period</label>
          <Select.Root type="single" bind:value={newPeriod}>
            <Select.Trigger class="w-full">
              {newPeriod === "monthly" ? "Monthly" : "Yearly"}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="monthly">Monthly</Select.Item>
              <Select.Item value="yearly">Yearly</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        <div class="space-y-1 w-32">
          <label for="budget-amount" class="text-xs font-medium">Amount</label>
          <Input id="budget-amount" type="number" step="0.01" placeholder="500.00" bind:value={newAmount} />
        </div>
        <div class="space-y-1 w-20">
          <label for="budget-currency" class="text-xs font-medium">Currency</label>
          <Input id="budget-currency" placeholder="USD" bind:value={newCurrency} />
        </div>
        <Button onclick={handleAdd} disabled={adding || !newPattern.trim() || !String(newAmount).trim()}>
          <Plus class="mr-1 h-4 w-4" />
          Add
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">Exact match or prefix (e.g. "Expenses:Food" includes "Expenses:Food:Groceries")</p>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Budget List -->
  {#if filteredBudgets.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>Budget Rules ({filteredBudgets.length})</Card.Title>
      </Card.Header>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={sort.key === "accountPattern"} direction={sort.direction} onclick={() => sort.toggle("accountPattern")}>Account Pattern</SortableHeader>
            <SortableHeader active={sort.key === "period"} direction={sort.direction} onclick={() => sort.toggle("period")}>Period</SortableHeader>
            <SortableHeader active={sort.key === "limit"} direction={sort.direction} onclick={() => sort.toggle("limit")} class="text-right">Limit</SortableHeader>
            <Table.Head class="text-right">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const sorted = sort.key && sort.direction ? sortItems(filteredBudgets, budgetAccessors[sort.key], sort.direction) : filteredBudgets}
          {#each sorted as budget (budget.id)}
            <Table.Row>
              {#if editingId === budget.id}
                <Table.Cell>
                  <Input bind:value={editPattern} class="h-8" />
                </Table.Cell>
                <Table.Cell>
                  <Select.Root type="single" bind:value={editPeriod}>
                    <Select.Trigger class="w-full h-8">
                      {editPeriod === "monthly" ? "Monthly" : "Yearly"}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="monthly">Monthly</Select.Item>
                      <Select.Item value="yearly">Yearly</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Table.Cell>
                <Table.Cell class="text-right">
                  <Input type="number" step="0.01" bind:value={editAmount} class="h-8 w-28 ml-auto" />
                </Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex justify-end gap-1">
                    <Button size="sm" onclick={() => saveEdit(budget)}>Save</Button>
                    <Button size="sm" variant="outline" onclick={() => { editingId = null; }}>Cancel</Button>
                  </div>
                </Table.Cell>
              {:else}
                <Table.Cell class="font-mono text-sm">{budget.account_pattern}</Table.Cell>
                <Table.Cell>
                  <Badge variant="secondary">{budget.period_type}</Badge>
                </Table.Cell>
                <Table.Cell class="text-right font-mono">
                  {budget.amount} {budget.currency}
                </Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onclick={() => startEdit(budget)}>Edit</Button>
                    <Button size="sm" variant="outline" onclick={() => handleDelete(budget.id)}>
                      <Trash2 class="h-3 w-3" />
                    </Button>
                  </div>
                </Table.Cell>
              {/if}
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {:else if budgets.length > 0 && searchTerm}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No budgets match "{searchTerm}".
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No budgets configured yet. Add one above to start tracking spending.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
