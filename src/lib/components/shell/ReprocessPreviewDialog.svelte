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
  import { invalidate } from "$lib/data/invalidation.js";
  import { toast } from "svelte-sonner";
  import * as m from "$paraglide/messages.js";

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
          const overrides = await backend.getCurrencyRateOverrides();
          for (const o of overrides) {
            if (o.set_by.startsWith("handler:")) {
              await backend.removeCurrencyRateOverride(o.currency);
            }
          }
        }
        if (preview.currencyHints) {
          for (const [currency, hint] of Object.entries(preview.currencyHints)) {
            const rateSource = hint.source ?? "none";
            await backend.setCurrencyRateOverride(currency, rateSource, `handler:${hint.handler}`);
          }
        }

        if (combined.changed > 0) invalidate("journal", "accounts", "reports");

        if (combined.errors.length > 0) {
          toast.warning(`Reprocessed ${combined.changed} transaction(s) with ${combined.errors.length} error(s)`);
        } else {
          toast.success(m.toast_reprocessed({ count: String(combined.changed) }));
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
      <Dialog.Title>{m.dialog_reprocess_preview_title()}</Dialog.Title>
      {#if reprocessStore.preview}
        <Dialog.Description>
          {m.dialog_reprocess_summary({
            changed: String(reprocessStore.preview.changed),
            total: String(reprocessStore.preview.total),
            unchanged: String(reprocessStore.preview.unchanged),
            skipped: String(reprocessStore.preview.skipped),
          })}
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    {#if reprocessStore.preview}
      <div class="space-y-3 overflow-y-auto flex-1 min-h-0">
        {#if reprocessStore.preview.changes.length > 0}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>{m.table_tx_hash()}</Table.Head>
                <Table.Head>{m.table_old_handler()}</Table.Head>
                <Table.Head>{m.table_new_handler()}</Table.Head>
                <Table.Head>{m.table_old_description()}</Table.Head>
                <Table.Head>{m.table_new_description()}</Table.Head>
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
              {m.label_errors_count({ count: String(reprocessStore.preview.errors.length) })}
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
          {m.btn_cancel()}
        </Button>
        <Button onclick={handleApplyReprocess} disabled={applyingReprocess}>
          {applyingReprocess ? m.state_applying() : m.dialog_apply_changes({ count: String(reprocessStore.preview.changed) })}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
