<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { ExtensionStore } from "$lib/data/extensions.svelte.js";
  import type { Extension } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";

  const extensionId = $derived(page.params.extensionId ?? "");
  const store = new ExtensionStore();

  let ext = $derived(store.byId.get(extensionId));

  // Config form
  let configEntries = $state<{ key: string; value: string }[]>([{ key: "", value: "" }]);

  // Action state
  let syncing = $state(false);
  let running = $state(false);
  let handlerParams = $state("");
  let reportFormat = $state("json");
  let lastOutput = $state<string | null>(null);

  function addConfigEntry() {
    configEntries = [...configEntries, { key: "", value: "" }];
  }

  function removeConfigEntry(index: number) {
    configEntries = configEntries.filter((_, i) => i !== index);
  }

  async function saveConfig() {
    const config: [string, string][] = configEntries
      .filter((e) => e.key.trim())
      .map((e) => [e.key.trim(), e.value]);
    try {
      await store.configure(extensionId, config);
      toast.success("Configuration saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSync() {
    syncing = true;
    lastOutput = null;
    try {
      const result = await store.sync(extensionId);
      lastOutput = result;
      toast.success("Sync complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      syncing = false;
    }
  }

  async function handleRun() {
    running = true;
    lastOutput = null;
    try {
      const result = await store.runHandler(extensionId, handlerParams);
      lastOutput = result;
      toast.success("Handler executed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  }

  async function handleGenerateReport() {
    running = true;
    try {
      const bytes = await store.generateReport(extensionId, reportFormat, handlerParams);
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${extensionId}-report.${reportFormat}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  }

  onMount(() => store.load());
</script>

<div class="space-y-6">
  <div>
    <a href="/extensions" class="text-sm text-muted-foreground hover:underline">&larr; Back to Extensions</a>
  </div>

  {#if store.loading}
    <div class="space-y-4">
      <Skeleton class="h-8 w-64" />
      <Skeleton class="h-4 w-96" />
      <Skeleton class="h-48 w-full" />
    </div>
  {:else if !ext}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">
          Extension "{extensionId}" not found. It may need to be installed.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-bold tracking-tight">{ext.name}</h1>
        <Badge variant="outline">{ext.version}</Badge>
        <Badge variant="secondary">{ext.kind}</Badge>
      </div>
      {#if ext.author}
        <p class="text-sm text-muted-foreground">by {ext.author}</p>
      {/if}
      <p class="text-muted-foreground mt-1">{ext.description}</p>
    </div>

    <!-- Capabilities -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Capabilities</Card.Title>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-wrap gap-2">
          {#if ext.capabilities.ledger_read}
            <Badge>Ledger Read</Badge>
          {/if}
          {#if ext.capabilities.ledger_write}
            <Badge>Ledger Write</Badge>
          {/if}
          {#if ext.capabilities.http}
            <Badge>HTTP</Badge>
          {/if}
          {#if ext.capabilities.allowed_domains.length > 0}
            {#each ext.capabilities.allowed_domains as domain}
              <Badge variant="outline">{domain}</Badge>
            {/each}
          {/if}
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Configuration -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Configuration</Card.Title>
        <Card.Description>Set key-value configuration pairs for this plugin.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="space-y-3">
          {#each configEntries as entry, i}
            <div class="flex gap-2 items-center">
              <Input
                placeholder="Key"
                bind:value={entry.key}
                class="flex-1"
              />
              <Input
                placeholder="Value"
                bind:value={entry.value}
                class="flex-1"
              />
              <Button variant="ghost" size="sm" onclick={() => removeConfigEntry(i)}>
                Remove
              </Button>
            </div>
          {/each}
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={addConfigEntry}>
              Add Entry
            </Button>
            <Button size="sm" onclick={saveConfig}>
              Save Configuration
            </Button>
          </div>
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Actions -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Actions</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if ext.kind === "source"}
          <div class="flex items-center gap-3">
            <Button disabled={syncing} onclick={handleSync}>
              {syncing ? "Syncing..." : "Sync Now"}
            </Button>
            <p class="text-sm text-muted-foreground">Pull data from this source into the ledger.</p>
          </div>
        {:else}
          <div class="space-y-3">
            <div class="space-y-2">
              <label for="params" class="text-sm font-medium">Parameters (JSON)</label>
              <Input id="params" bind:value={handlerParams} placeholder={'e.g. {"fiscal_year": 2025}'} />
            </div>
            <div class="flex items-center gap-3">
              <Button disabled={running} onclick={handleRun}>
                {running ? "Running..." : "Run Handler"}
              </Button>
            </div>

            <Separator />

            <div class="space-y-2">
              <label for="format" class="text-sm font-medium">Report Format</label>
              <select
                id="format"
                bind:value={reportFormat}
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
                <option value="text">Plain Text</option>
                <option value="beancount">Beancount</option>
                <option value="hledger">hledger</option>
              </select>
              <Button variant="outline" disabled={running} onclick={handleGenerateReport}>
                Download Report
              </Button>
            </div>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Output -->
    {#if lastOutput}
      <Card.Root>
        <Card.Header>
          <Card.Title>Output</Card.Title>
        </Card.Header>
        <Card.Content>
          <pre class="text-xs bg-muted p-4 rounded-md overflow-auto max-h-96 whitespace-pre-wrap">{lastOutput}</pre>
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
