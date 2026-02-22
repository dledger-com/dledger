<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { reprocessStore } from "$lib/data/reprocess-store.svelte.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import { getDefaultRegistry, applyReprocess } from "$lib/handlers/index.js";
  import type { ReprocessResult } from "$lib/handlers/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";

  const settings = new SettingsStore();
  const handlerRegistry = getDefaultRegistry();

  const isOpen = $derived(reprocessStore.preview !== null && reprocessStore.preview.changed > 0);
  const applyingReprocess = $derived(taskQueue.isActive("reprocess-apply"));

  function formatHash(hash: string): string {
    if (hash.length > 14) return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
    return hash;
  }

  function handleApplyReprocess() {
    const preview = reprocessStore.preview;
    const target = reprocessStore.target;
    if (!preview || preview.changes.length === 0) return;

    taskQueue.enqueue({
      key: "reprocess-apply",
      label: `Apply reprocess (${preview.changes.length} changes)`,
      async run(ctx) {
        const combined: ReprocessResult = {
          total: 0,
          unchanged: 0,
          changed: 0,
          skipped: 0,
          errors: [],
          changes: [],
          currencyHints: {},
        };

        const backend = getBackend();

        if (target) {
          const r = await applyReprocess(backend, handlerRegistry, {
            chainId: target.chainId,
            address: target.address,
            label: target.label,
            settings: settings.settings,
            onProgress: (processed, total) => {
              ctx.reportProgress({ current: processed, total });
            },
          }, preview.changes);
          combined.total += r.total;
          combined.changed += r.changed;
          combined.errors.push(...r.errors);
        } else {
          // All accounts — load from backend
          const accounts = await backend.listEtherscanAccounts();
          for (const account of accounts) {
            const r = await applyReprocess(backend, handlerRegistry, {
              chainId: account.chain_id,
              address: account.address,
              label: account.label,
              settings: settings.settings,
              onProgress: (processed, total) => {
                ctx.reportProgress({ current: combined.changed + processed, total: preview.changes.length });
              },
            }, preview.changes);
            combined.total += r.total;
            combined.changed += r.changed;
            combined.errors.push(...r.errors);
          }
        }

        // Rebuild currency rate sources from dry-run hints
        if (!target) {
          await backend.clearNonUserRateSources();
        }
        if (preview.currencyHints) {
          for (const [currency, hint] of Object.entries(preview.currencyHints)) {
            const rateSource = hint.source ?? "none";
            await backend.setCurrencyRateSource(currency, rateSource, `handler:${hint.handler}`);
          }
        }

        if (combined.errors.length > 0) {
          toast.warning(`Reprocessed ${combined.changed} transaction(s) with ${combined.errors.length} error(s)`);
        } else {
          toast.success(`Reprocessed ${combined.changed} transaction(s)`);
        }

        return { summary: `Reprocessed ${combined.changed} transaction(s)`, data: combined };
      },
    });

    // Clear preview immediately since the task owns it now
    reprocessStore.clear();
  }
</script>

<Dialog.Root
  open={isOpen}
  onOpenChange={(v) => { if (!v) reprocessStore.clear(); }}
>
  <Dialog.Content class="max-w-[90vw] sm:max-w-[90vw] max-h-[85vh] flex flex-col">
    <Dialog.Header>
      <Dialog.Title>Reprocess Preview</Dialog.Title>
      {#if reprocessStore.preview}
        <Dialog.Description>
          {reprocessStore.preview.changed} of {reprocessStore.preview.total} transaction(s) would change.
          {reprocessStore.preview.unchanged} unchanged, {reprocessStore.preview.skipped} skipped.
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    {#if reprocessStore.preview}
      <div class="space-y-3 overflow-y-auto flex-1 min-h-0">
        {#if reprocessStore.preview.changes.length > 0}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Tx Hash</Table.Head>
                <Table.Head>Old Handler</Table.Head>
                <Table.Head>New Handler</Table.Head>
                <Table.Head>Old Description</Table.Head>
                <Table.Head>New Description</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each reprocessStore.preview.changes as change}
                <Table.Row>
                  <Table.Cell class="font-mono text-xs">{formatHash(change.hash)}</Table.Cell>
                  <Table.Cell><Badge variant="secondary">{change.oldHandler}</Badge></Table.Cell>
                  <Table.Cell><Badge variant="default">{change.newHandler}</Badge></Table.Cell>
                  <Table.Cell class="text-xs max-w-48 truncate">{change.oldDescription}</Table.Cell>
                  <Table.Cell class="text-xs max-w-48 truncate">{change.newDescription}</Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}

        {#if reprocessStore.preview.errors.length > 0}
          <div>
            <p class="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Errors ({reprocessStore.preview.errors.length})
            </p>
            <ul class="mt-1 max-h-32 overflow-y-auto text-xs text-muted-foreground">
              {#each reprocessStore.preview.errors as error}
                <li class="py-0.5">{error}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>

      <Dialog.Footer>
        <Button variant="outline" onclick={() => reprocessStore.clear()}>
          Cancel
        </Button>
        <Button onclick={handleApplyReprocess} disabled={applyingReprocess}>
          {applyingReprocess ? "Applying..." : `Apply ${reprocessStore.preview.changed} Change(s)`}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
