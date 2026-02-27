<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLThAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { SortDirection } from "$lib/utils/sort.svelte.js";
	import ArrowUpDown from "lucide-svelte/icons/arrow-up-down";
	import ChevronUp from "lucide-svelte/icons/chevron-up";
	import ChevronDown from "lucide-svelte/icons/chevron-down";

	let {
		ref = $bindable(null),
		active = false,
		direction = null as SortDirection | null,
		onclick,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> & {
		active?: boolean;
		direction?: SortDirection | null;
		onclick?: () => void;
		children?: Snippet;
	} = $props();
</script>

<th
	bind:this={ref}
	data-slot="table-head"
	class={cn(
		"text-foreground h-10 bg-clip-padding px-2 text-start align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pe-0",
		className
	)}
	{...restProps}
>
	<button
		type="button"
		class="inline-flex w-full cursor-pointer select-none items-center gap-1 hover:text-foreground/70"
		onclick={onclick}
	>
		{@render children?.()}
		{#if active && direction === "asc"}
			<ChevronUp class="size-4 shrink-0" />
		{:else if active && direction === "desc"}
			<ChevronDown class="size-4 shrink-0" />
		{:else}
			<ArrowUpDown class="text-muted-foreground size-3.5 shrink-0" />
		{/if}
	</button>
</th>
