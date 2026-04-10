<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { getBackend } from "$lib/backend.js";
  import { exportData, downloadExport } from "$lib/export/export.js";
  import { loadSettings, saveToStorage, type AppSettings } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import ShieldAlert from "lucide-svelte/icons/shield-alert";
  import Download from "lucide-svelte/icons/download";
  import Loader from "lucide-svelte/icons/loader";
  import * as m from "$paraglide/messages.js";

  let {
    onlearnmore,
  }: {
    onlearnmore?: () => void;
  } = $props();

  const BACKUP_REMINDER_DAYS = 7;

  const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

  let settings = $state<AppSettings>(loadSettings());
  let exporting = $state(false);

  let daysAgo = $derived.by(() => {
    if (!settings.lastExportDate) return null;
    const diff = Date.now() - new Date(settings.lastExportDate).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  });

  let isOverdue = $derived(daysAgo === null || daysAgo >= BACKUP_REMINDER_DAYS);

  async function handleQuickExport() {
    exporting = true;
    try {
      const backend = getBackend();
      const data = await exportData(backend, {});
      downloadExport(data, false);
      const now = new Date().toISOString();
      settings.lastExportDate = now;
      saveToStorage(settings);
      toast.success(m.toast_quick_export_success());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      exporting = false;
    }
  }
</script>

{#if !isTauri && isOverdue}
  <div class="px-2 pb-2">
    <Card.Root class="border-amber-200 bg-amber-50/50 dark:border-amber-400/20 dark:bg-amber-400/5">
      <Card.Content class="py-3 px-3 space-y-2">
        <div class="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <ShieldAlert class="h-4 w-4 shrink-0" />
          <span>{m.backup_reminder_title()}</span>
        </div>
        <p class="text-xs text-muted-foreground">
          {#if daysAgo !== null}
            {m.backup_reminder_overdue({ days: daysAgo })}
          {:else}
            {m.backup_reminder_never()}
          {/if}
        </p>
        <div class="flex flex-col gap-1.5">
          <Button size="sm" variant="outline" class="h-7 text-xs w-full" onclick={handleQuickExport} disabled={exporting}>
            {#if exporting}
              <Loader class="h-3 w-3 mr-1 animate-spin" />
            {:else}
              <Download class="h-3 w-3 mr-1" />
            {/if}
            {m.backup_reminder_export()}
          </Button>
          <Button size="sm" variant="ghost" class="h-7 text-xs w-full" onclick={() => onlearnmore?.()}>
            {m.backup_reminder_learn_more()}
          </Button>
        </div>
      </Card.Content>
    </Card.Root>
  </div>
{/if}
