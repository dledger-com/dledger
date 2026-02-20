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

  const settings = new SettingsStore();
  const now = new Date();

  let fromDate = $state(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`);
  let toDate = $state(now.toISOString().slice(0, 10));
  let loading = $state(false);
  let report = $state<BudgetReport | null>(null);
  let error = $state<string | null>(null);

  async function generate() {
    loading = true;
    error = null;
    report = null;
    try {
      const backend = getBackend();
      const budgets = await backend.listBudgets();
      if (budgets.length === 0) {
        error = "No budgets configured. Add budgets first.";
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
    if (percent >= 100) return { variant: "destructive", label: "Over budget" };
    if (percent >= 80) return { variant: "secondary", label: "Near limit" };
    return { variant: "default", label: "On track" };
  }

  onMount(generate);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Budget Report</h1>
    <p class="text-muted-foreground">
      Compare actual spending against budget targets.
      <a href="/budgets" class="underline hover:text-foreground">Manage budgets</a>.
    </p>
  </div>

  <div class="flex items-end gap-4 flex-wrap">
    <div class="space-y-2">
      <label for="from" class="text-sm font-medium">From</label>
      <Input id="from" type="date" bind:value={fromDate} class="w-48" />
    </div>
    <div class="space-y-2">
      <label for="to" class="text-sm font-medium">To</label>
      <Input id="to" type="date" bind:value={toDate} class="w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? "Loading..." : "Generate"}
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
          {#if error.includes("No budgets")}
            <a href="/budgets" class="underline hover:text-foreground ml-1">Add budgets</a>
          {/if}
        </p>
      </Card.Content>
    </Card.Root>
  {:else if report && report.comparisons.length > 0}
    <Card.Root>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Account Pattern</Table.Head>
            <Table.Head>Period</Table.Head>
            <Table.Head class="text-right">Budget</Table.Head>
            <Table.Head class="text-right">Actual</Table.Head>
            <Table.Head class="text-right">Remaining</Table.Head>
            <Table.Head class="w-48">Progress</Table.Head>
            <Table.Head>Status</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each report.comparisons as comp (comp.budget.id)}
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
              <Table.Cell class="text-right font-mono {comp.remaining < 0 ? 'text-red-600 dark:text-red-400' : ''}">
                {formatCurrency(comp.remaining, comp.budget.currency)}
              </Table.Cell>
              <Table.Cell>
                <div class="flex items-center gap-2">
                  <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      class="h-full transition-all duration-300 {progressColor(comp.percent_used)}"
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
          No budget comparisons for this period.
        </p>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
