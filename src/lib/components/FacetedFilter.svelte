<script lang="ts">
	import * as Popover from "$lib/components/ui/popover/index.js";
	import * as Command from "$lib/components/ui/command/index.js";
	import { Checkbox } from "$lib/components/ui/checkbox/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import Separator from "$lib/components/ui/separator/separator.svelte";
	import CirclePlus from "lucide-svelte/icons/circle-plus";
	import * as m from "$paraglide/messages.js";

	interface Props {
		title: string;
		options: { value: string; label: string }[];
		selected: Set<string>;
	}

	let { title, options, selected = $bindable() }: Props = $props();

	let open = $state(false);
	let search = $state("");

	const filtered = $derived(
		search
			? options.filter((o) =>
					o.label.toLowerCase().includes(search.toLowerCase()),
				)
			: options,
	);

	function toggle(value: string) {
		const next = new Set(selected);
		if (next.has(value)) {
			next.delete(value);
		} else {
			next.add(value);
		}
		selected = next;
	}

	function clear() {
		selected = new Set();
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button variant="outline" size="sm" class="h-8 border-dashed" {...props}>
				<CirclePlus class="size-4" />
				{title}
				{#if selected.size > 0}
					<Separator orientation="vertical" class="mx-1 h-4" />
					<Badge variant="secondary" class="rounded-sm px-1 font-normal">
						{m.filter_n_selected({ count: String(selected.size) })}
					</Badge>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-[220px] p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input
				placeholder={m.placeholder_search_facet({ facet: title.toLowerCase() })}
				bind:value={search}
			/>
			<Command.List class="max-h-[300px]">
				<Command.Empty>{m.filter_no_results()}</Command.Empty>
				<Command.Group>
					{#each filtered as option (option.value)}
						<Command.Item
							value={option.value}
							onSelect={() => toggle(option.value)}
						>
							<Checkbox
								checked={selected.has(option.value)}
								class="pointer-events-none"
							/>
							<span class="truncate">{option.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
				{#if selected.size > 0}
					<Command.Separator />
					<Command.Group>
						<Command.Item
							class="justify-center text-center"
							onSelect={clear}
						>
							{m.filter_clear()}
						</Command.Item>
					</Command.Group>
				{/if}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
