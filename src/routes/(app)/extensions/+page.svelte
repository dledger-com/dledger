<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { ExtensionStore } from "$lib/data/extensions.svelte.js";
  import { toast } from "svelte-sonner";

  const store = new ExtensionStore();
  let syncing = $state<string | null>(null);

  async function handleSync(id: string) {
    syncing = id;
    try {
      const result = await store.sync(id);
      toast.success(`Sync complete: ${result}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      syncing = null;
    }
  }

  onMount(() => store.load());
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Extensions</h1>
    <p class="text-muted-foreground">Manage and configure installed extensions.</p>
  </div>

  {#if store.loading}
    <Card.Root>
      <Card.Content class="py-4">
        <div class="space-y-2">
          {#each [1, 2, 3] as _}
            <Skeleton class="h-20 w-full" />
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {:else if store.extensions.length === 0}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          No extensions found. Place plugin WASM files in the plugins directory to get started.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    {#if store.sources.length > 0}
      <div class="space-y-3">
        <h2 class="text-lg font-semibold">Sources</h2>
        <div class="grid gap-3">
          {#each store.sources as ext (ext.id)}
            <Card.Root>
              <Card.Content class="flex items-center justify-between py-4">
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <a href="/extensions/{ext.id}" class="font-medium hover:underline">{ext.name}</a>
                    <Badge variant="outline">{ext.version}</Badge>
                    <Badge variant="secondary">source</Badge>
                    {#if ext.capabilities.http}
                      <Badge variant="outline">http</Badge>
                    {/if}
                    {#if ext.capabilities.ledger_write}
                      <Badge variant="outline">write</Badge>
                    {/if}
                  </div>
                  <p class="text-sm text-muted-foreground">{ext.description}</p>
                </div>
                <Button
                  size="sm"
                  disabled={syncing === ext.id}
                  onclick={() => handleSync(ext.id)}
                >
                  {syncing === ext.id ? "Syncing..." : "Sync"}
                </Button>
              </Card.Content>
            </Card.Root>
          {/each}
        </div>
      </div>
    {/if}

    {#if store.sources.length > 0 && store.handlers.length > 0}
      <Separator />
    {/if}

    {#if store.handlers.length > 0}
      <div class="space-y-3">
        <h2 class="text-lg font-semibold">Handlers</h2>
        <div class="grid gap-3">
          {#each store.handlers as ext (ext.id)}
            <Card.Root>
              <Card.Content class="flex items-center justify-between py-4">
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <a href="/extensions/{ext.id}" class="font-medium hover:underline">{ext.name}</a>
                    <Badge variant="outline">{ext.version}</Badge>
                    <Badge variant="secondary">handler</Badge>
                    {#if ext.capabilities.ledger_read}
                      <Badge variant="outline">read</Badge>
                    {/if}
                  </div>
                  <p class="text-sm text-muted-foreground">{ext.description}</p>
                </div>
                <Button size="sm" variant="outline" href="/extensions/{ext.id}">
                  Configure
                </Button>
              </Card.Content>
            </Card.Root>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
