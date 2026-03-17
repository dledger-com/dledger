<script lang="ts">
  import type { LineItem } from "$lib/types/index.js";
  import type { AccountType } from "$lib/types/account.js";
  import { pairLineItems, type FlowType } from "$lib/utils/flow-pairing.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import ArrowDown from "lucide-svelte/icons/arrow-down";

  interface Props {
    items: LineItem[];
    accountName: (id: string) => string;
    accountTypeLookup: (id: string) => AccountType | undefined;
  }

  let { items, accountName, accountTypeLookup }: Props = $props();

  const flows = $derived(pairLineItems(items, accountTypeLookup));

  const colorClasses: Record<FlowType, string> = {
    income:   "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950",
    expense:  "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950",
    transfer: "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950",
    equity:   "border-purple-300 bg-purple-50 dark:border-purple-800 dark:bg-purple-950",
    mixed:    "border-border bg-muted/30",
  };

  const arrowClasses: Record<FlowType, string> = {
    income:   "text-green-600 dark:text-green-400",
    expense:  "text-red-600 dark:text-red-400",
    transfer: "text-blue-600 dark:text-blue-400",
    equity:   "text-purple-600 dark:text-purple-400",
    mixed:    "text-muted-foreground",
  };

  const labelClasses: Record<FlowType, string> = {
    income:   "text-green-700 dark:text-green-300",
    expense:  "text-red-700 dark:text-red-300",
    transfer: "text-blue-700 dark:text-blue-300",
    equity:   "text-purple-700 dark:text-purple-300",
    mixed:    "text-muted-foreground",
  };
</script>

{#if flows.length === 0}
  <p class="text-sm text-muted-foreground text-center py-4">No flows to display.</p>
{:else}
  <div class="space-y-3">
    {#each flows as flow, i (i)}
      <div class="rounded-md border p-3 {colorClasses[flow.flowType]}">
        <!-- Source -->
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium uppercase {labelClasses[flow.flowType]}">From</span>
          <span class="text-sm break-words">
            {flow.sourceAccountId ? accountName(flow.sourceAccountId) : "—"}
          </span>
        </div>

        <!-- Arrow + Amount -->
        <div class="flex items-center gap-2 my-2 pl-4">
          <ArrowDown class="h-4 w-4 shrink-0 {arrowClasses[flow.flowType]}" />
          <span class="font-mono text-sm font-semibold">
            {formatCurrency(flow.amount, flow.currency)}
          </span>
          <span class="text-xs capitalize {labelClasses[flow.flowType]}">{flow.flowType}</span>
        </div>

        <!-- Destination -->
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium uppercase {labelClasses[flow.flowType]}">To</span>
          <span class="text-sm break-words">
            {flow.destAccountId ? accountName(flow.destAccountId) : "—"}
          </span>
        </div>
      </div>
    {/each}
  </div>
{/if}
