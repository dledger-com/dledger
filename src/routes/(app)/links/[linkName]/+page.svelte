<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { getBackend } from "$lib/backend.js";
  import { AccountStore } from "$lib/data/accounts.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { parseTags, TAGS_META_KEY } from "$lib/utils/tags.js";
  import { linkColor } from "$lib/utils/links.js";
  import TagDisplay from "$lib/components/TagDisplay.svelte";
  import LinkDisplay from "$lib/components/LinkDisplay.svelte";
  import Link2 from "lucide-svelte/icons/link-2";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";
  import ArrowUp from "lucide-svelte/icons/arrow-up";
  import { cn } from "$lib/utils.js";
  import type { JournalEntry, LineItem } from "$lib/types/index.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";

  const accountStore = new AccountStore();
  const settings = new SettingsStore();

  const linkName = $derived(decodeURIComponent(page.params.linkName ?? ""));

  let entries = $state<Array<{ entry: JournalEntry; items: LineItem[]; tags: string[]; links: string[] }>>([]);
  let loading = $state(true);

  let scrollEl = $state<HTMLDivElement | null>(null);

  const virtualizer = createVirtualizer(() => ({
    count: entries.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 44,
    overscan: 10,
  }));

  const virtualItems = $derived(
    virtualizer.getVirtualItems().filter((row) => row.index < entries.length)
  );
  const totalSize = $derived(virtualizer.getTotalSize());
  const paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  const paddingBottom = $derived(
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0
  );
  const isScrolledDown = $derived(virtualItems.length > 0 && virtualItems[0].index > 0);

  function accountName(id: string): string {
    return accountStore.byId.get(id)?.full_name ?? id;
  }

  function totalDebits(items: LineItem[]): string {
    let total = 0;
    for (const item of items) {
      const amt = parseFloat(item.amount);
      if (amt > 0) total += amt;
    }
    const curr = items[0]?.currency ?? settings.currency;
    return formatCurrency(total, curr);
  }

  onMount(async () => {
    await accountStore.load();
    const backend = getBackend();
    const entryIds = await backend.getEntriesByLink(linkName);
    const results = await Promise.all(
      entryIds.map(async (id) => {
        const [entryResult, meta, links] = await Promise.all([
          backend.getJournalEntry(id),
          backend.getMetadata(id).catch(() => ({}) as Record<string, string>),
          backend.getEntryLinks(id).catch(() => [] as string[]),
        ]);
        if (!entryResult) return null;
        return {
          entry: entryResult[0],
          items: entryResult[1],
          tags: parseTags(meta[TAGS_META_KEY]),
          links,
        };
      }),
    );
    entries = results.filter((r): r is NonNullable<typeof r> => r !== null);
    loading = false;
  });
</script>

<div class="space-y-6">
  <div class="flex items-center gap-4">
    <Button variant="ghost" size="icon" href="/links">
      <ArrowLeft class="h-4 w-4" />
    </Button>
    <div>
      <div class="flex items-center gap-2">
        <Link2 class="h-5 w-5 text-muted-foreground" />
        <h1 class="text-2xl font-bold tracking-tight">
          <Badge variant="outline" class={cn(linkColor(linkName), "border-transparent text-lg px-3 py-0.5")}>
            ^{linkName}
          </Badge>
        </h1>
      </div>
      <p class="text-muted-foreground mt-1">{entries.length} linked {entries.length === 1 ? "entry" : "entries"}</p>
    </div>
  </div>

  {#if loading}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if entries.length === 0}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">No entries found for this link.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-x-0 rounded-none shadow-none py-0">
      <div class="relative">
        <div bind:this={scrollEl} class="overflow-y-auto max-h-[calc(100vh-220px)] [&_[data-slot=table-container]]:overflow-visible">
          <Table.Root>
            <Table.Header class="sticky top-0 z-10 bg-background">
              <Table.Row>
                <Table.Head>Date</Table.Head>
                <Table.Head>Description</Table.Head>
                <Table.Head class="hidden md:table-cell">Status</Table.Head>
                <Table.Head class="text-right">Amount</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#if paddingTop > 0}
                <tr><td style="height: {paddingTop}px;" colspan="4"></td></tr>
              {/if}
              {#each virtualItems as row (row.key)}
                {@const { entry, items, tags, links } = entries[row.index]}
                <Table.Row>
                  <Table.Cell class="text-muted-foreground">{entry.date}</Table.Cell>
                  <Table.Cell class="max-w-[300px]">
                    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                      <a href="/journal/{entry.id}" class="font-medium hover:underline truncate" title={entry.description}>{entry.description}</a>
                      {#if tags.length > 0}
                        <TagDisplay {tags} class="shrink-0" />
                      {/if}
                      {#if links.length > 0}
                        <LinkDisplay {links} class="shrink-0" />
                      {/if}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="hidden md:table-cell">
                    <Badge variant={entry.status === "confirmed" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                      {entry.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">{totalDebits(items)}</Table.Cell>
                </Table.Row>
              {/each}
              {#if paddingBottom > 0}
                <tr><td style="height: {paddingBottom}px;" colspan="4"></td></tr>
              {/if}
            </Table.Body>
          </Table.Root>
        </div>

        {#if isScrolledDown}
          <button type="button"
            class="absolute bottom-3 right-4 z-20 flex h-8 w-8 items-center
                   justify-center rounded-full border bg-background/95
                   text-muted-foreground shadow-sm backdrop-blur-sm
                   hover:text-foreground"
            onclick={() => virtualizer.scrollToOffset(0, { behavior: "smooth" })}
            title="Back to top">
            <ArrowUp class="size-4" />
          </button>
        {/if}
      </div>
    </Card.Root>

    <span class="text-sm text-muted-foreground">
      {entries.length} {entries.length === 1 ? "entry" : "entries"}
    </span>
  {/if}
</div>
