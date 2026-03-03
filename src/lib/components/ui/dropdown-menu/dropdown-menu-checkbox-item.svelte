<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import Check from "lucide-svelte/icons/check";
	import { cn } from "$lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		class: className,
		children: childContent,
		...restProps
	}: Omit<DropdownMenuPrimitive.CheckboxItemProps, "children"> & {
		children?: Snippet;
	} = $props();
</script>

<DropdownMenuPrimitive.CheckboxItem
	bind:ref
	bind:checked
	data-slot="dropdown-menu-checkbox-item"
	class={cn(
		"focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked: isChecked })}
		<span class="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
			{#if isChecked}
				<Check class="size-4" />
			{/if}
		</span>
		{@render childContent?.()}
	{/snippet}
</DropdownMenuPrimitive.CheckboxItem>
