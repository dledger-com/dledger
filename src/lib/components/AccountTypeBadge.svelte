<script lang="ts">
  import Badge from "$lib/components/ui/badge/badge.svelte";
  import { cn } from "$lib/utils.js";
  import type { AccountType } from "$lib/types/account.js";

  let { type, class: className }: { type: AccountType; class?: string } = $props();

  const colorMap: Record<AccountType, string> = {
    asset: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    liability: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    equity: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    revenue: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    expense: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  };
</script>

<Badge variant="outline" class={cn(colorMap[type], "border-transparent", className)}>
  {type}
</Badge>
