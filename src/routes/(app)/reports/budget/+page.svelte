<svelte:head><title>Budget Report · dLedger</title></svelte:head>

<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { computeBudgetReport } from "$lib/utils/budget-compare.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import type { BudgetReport } from "$lib/types/index.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import * as m from "$paraglide/messages.js";

  const settings = new SettingsStore();
  const now = new Date();

  let fromDate = $state(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`);
  let toDate = $state(now.toISOString().slice(0, 10));
  let loading = $state(false);
  let report = $state<BudgetReport | null>(null);
  let error = $state<string | null>(null);

  type BudgetSortKey = "accountPattern" | "period" | "budget" | "actual" | "remaining" | "status";
  const sort = createSortState<BudgetSortKey>();
  const budgetAccessors: Record<BudgetSortKey, (c: any) => string | number | null> = {
    accountPattern: (c) => c.budget.account_pattern,
    period: (c) => c.budget.period_type,
    budget: (c) => parseFloat(c.budget.amount),
    actual: (c) => c.actual,
    remaining: (c) => c.remaining,
    status: (c) => c.percent_used,
  };

  async function generate() {
    loading = true;
    error = null;
    report = null;
    try {
      const backend = getBackend();
      const budgets = await backend.listBudgets();
      if (budgets.length === 0) {
        error = m.report_no_budgets_configured();
        return;
      }
      report = await computeBudgetReport(backend, budgets, fromDate, toDate);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function setMTD() {
    const now = new Date();
    fromDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    toDate = now.toISOString().slice(0, 10);
  }

  function setYTD() {
    const now = new Date();
    fromDate = `${now.getFullYear()}-01-01`;
    toDate = now.toISOString().slice(0, 10);
  }

  function progressColor(percent: number): string {
    if (percent >= 100) return "bg-red-500";
    if (percent >= 80) return "bg-yellow-500";
    return "bg-green-500";
  }

  function statusBadge(percent: number): { variant: "default" | "secondary" | "destructive"; label: string } {
    if (percent >= 100) return { variant: "destructive", label: m.budget_over() };
    if (percent >= 80) return { variant: "secondary", label: m.budget_near_limit() };
    return { variant: "default", label: m.budget_on_track() };
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div class="flex items-end gap-4 flex-wrap">
    <div class="space-y-2">
      <label for="from" class="text-sm font-medium">{m.label_from()}</label>
      <Input id="from" type="date" bind:value={fromDate} class="w-48" />
    </div>
    <div class="space-y-2">
      <label for="to" class="text-sm font-medium">{m.label_to()}</label>
      <Input id="to" type="date" bind:value={toDate} class="w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? m.state_loading_report() : m.btn_generate()}
    </Button>
    <Button variant="outline" onclick={() => { setMTD(); generate(); }}>MTD</Button>
    <Button variant="outline" onclick={() => { setYTD(); generate(); }}>YTD</Button>
  </div>

  {#if loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {error}
          {#if error === m.report_no_budgets_configured()}
            <a href="/budgets" class="underline hover:text-foreground ml-1">{m.report_add_budgets()}</a>
          {/if}
        </p>
      </Card.Content>
    </Card.Root>
  {:else if report && report.comparisons.length > 0}
    <Card.Root>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <SortableHeader active={sort.key === "accountPattern"} direction={sort.direction} onclick={() => sort.toggle("accountPattern")}>{m.label_account_pattern()}</SortableHeader>
            <SortableHeader active={sort.key === "period"} direction={sort.direction} onclick={() => sort.toggle("period")}>{m.label_period()}</SortableHeader>
            <SortableHeader active={sort.key === "budget"} direction={sort.direction} onclick={() => sort.toggle("budget")} class="text-right">{m.report_budget()}</SortableHeader>
            <SortableHeader active={sort.key === "actual"} direction={sort.direction} onclick={() => sort.toggle("actual")} class="text-right">{m.label_actual()}</SortableHeader>
            <SortableHeader active={sort.key === "remaining"} direction={sort.direction} onclick={() => sort.toggle("remaining")} class="text-right">{m.label_remaining()}</SortableHeader>
            <Table.Head class="w-48">{m.report_progress()}</Table.Head>
            <SortableHeader active={sort.key === "status"} direction={sort.direction} onclick={() => sort.toggle("status")}>{m.label_status()}</SortableHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {@const sortedComps = sort.key && sort.direction ? sortItems(report.comparisons, budgetAccessors[sort.key], sort.direction) : report.comparisons}
          {#each sortedComps as comp (comp.budget.id)}
            {@const status = statusBadge(comp.percent_used)}
            <Table.Row>
              <Table.Cell class="font-mono text-sm">{comp.budget.account_pattern}</Table.Cell>
              <Table.Cell>
                <Badge variant="secondary">{comp.budget.period_type}</Badge>
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {formatCurrency(parseFloat(comp.budget.amount), comp.budget.currency)}
              </Table.Cell>
              <Table.Cell class="text-right font-mono">
                {formatCurrency(comp.actual, comp.budget.currency)}
              </Table.Cell>
              <Table.Cell class="text-right font-mono {comp.remaining < 0 ? 'text-negative' : ''}">
                {formatCurrency(comp.remaining, comp.budget.currency)}
              </Table.Cell>
              <Table.Cell>
                <div class="flex items-center gap-2">
                  <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      class="h-full transition-[width] duration-200 {progressColor(comp.percent_used)}"
                      style="width: {Math.min(comp.percent_used, 100)}%"
                    ></div>
                  </div>
                  <span class="text-xs text-muted-foreground w-12 text-right">
                    {Math.round(comp.percent_used)}%
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <Badge variant={status.variant}>{status.label}</Badge>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Root>
  {:else if report}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          {m.report_no_budget_comparisons()}
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
