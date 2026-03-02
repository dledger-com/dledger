<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { getBackend } from "$lib/backend.js";
  import { linkColor } from "$lib/utils/links.js";
  import { getCachedLinks, setCachedLinks } from "$lib/data/links-cache.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";
  import Link2 from "lucide-svelte/icons/link-2";
  import { cn } from "$lib/utils.js";

  const cached = getCachedLinks();
  let linksWithCounts = $state(cached ?? []);
  let loading = $state(cached === null);

  onMount(async () => {
    linksWithCounts = await getBackend().getAllLinksWithCounts();
    setCachedLinks(linksWithCounts);
    loading = false;
  });

  const unsubJournal = onInvalidate("journal", async () => {
    linksWithCounts = await getBackend().getAllLinksWithCounts();
    setCachedLinks(linksWithCounts);
  });
  onDestroy(unsubJournal);

  // Virtual scrolling
  let scrollEl = $state<HTMLDivElement | null>(null);

  const virtualizer = createVirtualizer(() => ({
    count: linksWithCounts.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 40,
    overscan: 10,
  }));

  const virtualItems = $derived(
    virtualizer.getVirtualItems().filter((row) => row.index < linksWithCounts.length)
  );
  const totalSize = $derived(virtualizer.getTotalSize());
  const paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  const paddingBottom = $derived(
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Links</h1>
    <p class="text-muted-foreground">Transaction links group related journal entries together.</p>
  </div>

  {#if loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-10 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if linksWithCounts.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">No links yet. Add links to journal entries to group related transactions together.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <div bind:this={scrollEl} class="overflow-y-auto max-h-[calc(100vh-180px)] [&_[data-slot=table-container]]:overflow-visible">
      <Table.Root>
        <Table.Header class="sticky top-0 z-10 bg-background">
          <Table.Row>
            <Table.Head>Link</Table.Head>
            <Table.Head class="text-right">Entries</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#if paddingTop > 0}
            <tr><td style="height: {paddingTop}px;" colspan="2"></td></tr>
          {/if}
          {#each virtualItems as row (row.key)}
            {@const { link_name, entry_count } = linksWithCounts[row.index]}
            <Table.Row>
              <Table.Cell>
                <a href="/links/{encodeURIComponent(link_name)}" class="inline-flex">
                  <Badge variant="outline" class={cn(linkColor(link_name), "border-transparent text-xs px-2 py-0.5 gap-1 cursor-pointer hover:opacity-80")}>
                    <Link2 class="h-3 w-3" />
                    {link_name}
                  </Badge>
                </a>
              </Table.Cell>
              <Table.Cell class="text-right font-mono">{entry_count}</Table.Cell>
            </Table.Row>
          {/each}
          {#if paddingBottom > 0}
            <tr><td style="height: {paddingBottom}px;" colspan="2"></td></tr>
          {/if}
        </Table.Body>
      </Table.Root>
      </div>
    </Card.Root>
  {/if}
</div>
