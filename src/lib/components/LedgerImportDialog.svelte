<script lang="ts">
  import { untrack } from "svelte";
  import { invalidate } from "$lib/data/invalidation.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import { readFileAsText } from "$lib/utils/read-file-text.js";
  import { detectFormat, detectFormatFromFilename, formatLabel, type LedgerFormat } from "$lib/ledger-format.js";
  import { resolveIncludes, filterLedgerFiles } from "$lib/ledger-include.js";
  import { unzipSync, strFromU8 } from "fflate";
  import {
    enqueueRateBackfill,
  } from "$lib/exchange-rate-historical.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import * as m from "$paraglide/messages.js";

  let {
    open = $bindable(false),
    initialContent = "",
    initialFileName = "",
  }: {
    open: boolean;
    initialContent?: string;
    initialFileName?: string;
  } = $props();

  const settings = new SettingsStore();

  const ALL_FORMATS: LedgerFormat[] = ["ledger", "beancount", "hledger"];

  // -- State --
  let fileContent = $state("");
  let fileName = $state<string | null>(null);
  let fileCount = $state(0);
  let formatOverride = $state<LedgerFormat | null>(null);

  let detectedFormat = $derived<LedgerFormat | null>(
    fileName ? detectFormatFromFilename(fileName) ?? (fileContent.trim() ? detectFormat(fileContent) : null)
             : fileContent.trim() ? detectFormat(fileContent) : null,
  );
  let effectiveFormat = $derived(formatOverride ?? detectedFormat);
  let previewLines = $derived(
    fileContent
      ? fileContent.split("\n").slice(0, 10).filter((l: string) => l.trim())
      : [],
  );

  async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
      const file = files[0];
      fileName = file.name;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(buf);
        const fileMap = new Map<string, string>();
        for (const [name, data] of Object.entries(entries)) {
          fileMap.set(name, strFromU8(data));
        }
        const ledgerFiles = filterLedgerFiles(fileMap);
        fileCount = ledgerFiles.length;
        if (ledgerFiles.length === 0) {
          toast.error(m.toast_no_ledger_files_in_archive());
          fileContent = "";
          return;
        }
        const parts: string[] = [];
        for (const [name, content] of ledgerFiles) {
          parts.push(resolveIncludes(content, fileMap));
        }
        fileContent = parts.join("\n\n");
      } catch (err) {
        toast.error(m.toast_zip_read_failed({ message: String(err) }));
        fileContent = "";
      }
    } else if (files.length > 1) {
      const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
      fileName = `${sorted[0].name} +${sorted.length - 1}`;
      fileCount = sorted.length;
      const fileMap = new Map<string, string>();
      const parts: string[] = [];
      for (const f of sorted) {
        const text = await readFileAsText(f);
        fileMap.set(f.name, text);
        parts.push(text);
      }
      fileContent = parts
        .map((content) => resolveIncludes(content, fileMap))
        .join("\n\n");
    } else {
      const file = files[0];
      fileName = file.name;
      fileCount = 1;
      fileContent = await readFileAsText(file);
    }
  }

  function handleImport() {
    if (!fileContent.trim()) {
      toast.error(m.error_no_ledger_data());
      return;
    }

    const contentSnapshot = fileContent;
    const formatSnapshot = effectiveFormat ?? undefined;

    const taskId = taskQueue.enqueue({
      key: "ledger-import",
      label: m.task_ledger_import(),
      description: m.task_ledger_import_desc(),
      run: async (ctx) => {
        const backend = getBackend();
        const importResult = await backend.importLedgerFile(contentSnapshot, formatSnapshot, {
          signal: ctx.signal,
          onProgress: (p) => ctx.reportProgress(p),
        });
        const parts = [m.toast_ledger_transactions_imported({ count: importResult.transactions_imported })];
        if (importResult.duplicates_skipped > 0) {
          parts.push(m.toast_ledger_duplicates_skipped({ count: importResult.duplicates_skipped }));
        }
        toast.success(parts.join(", "));
        if (importResult.transactions_imported > 0) invalidate("journal", "accounts", "reports");

        // Auto-backfill missing exchange rates for imported currencies
        if (importResult.transaction_currency_dates && importResult.transaction_currency_dates.length > 0) {
          enqueueRateBackfill(
            taskQueue,
            backend,
            settings.buildRateConfig(),
            getHiddenCurrencySet(),
            importResult.transaction_currency_dates,
          );
        }

        return {
          summary: parts.join(", "),
          data: importResult,
        };
      },
    });

    if (taskId) {
      open = false;
    } else {
      toast.error(m.error_import_in_progress());
    }
  }

  function resetDialog() {
    fileContent = "";
    fileName = null;
    fileCount = 0;
    formatOverride = null;
  }

  // Reset format override when file content changes (new file loaded)
  $effect(() => {
    fileContent;
    untrack(() => { formatOverride = null; });
  });

  // Auto-advance when opened with initial content (drag-and-drop),
  // or reset state on manual open. No reset on close to avoid flash.
  $effect.pre(() => {
    if (open && initialContent) {
      fileContent = initialContent;
      fileName = initialFileName;
    } else if (open) {
      untrack(() => resetDialog());
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{m.dialog_ledger_import()}</Dialog.Title>
      <Dialog.Description>
        {m.dialog_ledger_import_desc()}
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
        <!-- File picker -->
        <div class="flex items-center gap-4">
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            <Upload class="h-4 w-4" />
            <span>{fileName || m.btn_choose_file()}</span>
            <input
              type="file"
              accept=".ledger,.beancount,.journal,.hledger,.txt,.zip"
              multiple
              class="hidden"
              onchange={handleFileSelect}
            />
          </label>
          {#if fileName}
            <span class="flex items-center gap-1 text-sm text-muted-foreground">
              <FileText class="h-4 w-4" />
              {fileName}
            </span>
            {#if fileCount > 1}
              <Badge variant="secondary">{m.label_files_count({ count: fileCount })}</Badge>
            {/if}
          {/if}
        </div>

        {#if detectedFormat}
          <div class="flex items-center gap-3 rounded-md border p-3">
            <span class="text-sm text-muted-foreground">{m.import_detected_format()} <strong>{formatLabel(detectedFormat)}</strong></span>
            <div class="flex gap-1">
              {#each ALL_FORMATS as fmt}
                <Button
                  size="sm"
                  class="text-xs h-7"
                  variant={effectiveFormat === fmt ? "default" : "outline"}
                  onclick={() => { formatOverride = fmt === detectedFormat ? null : fmt; }}
                >
                  {formatLabel(fmt)}
                </Button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Textarea for paste -->
        <textarea
          bind:value={fileContent}
          rows="10"
          class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={"2024-01-01 open Assets:Bank:Checking  USD\n2024-01-01 open Expenses:Food\n\n2024-01-15 * Grocery Store\n  Expenses:Food          50.00 USD\n  Assets:Bank:Checking  -50.00 USD"}
        ></textarea>

        <!-- Preview -->
        {#if previewLines.length > 0}
          <div class="rounded-md border bg-muted/50 p-3">
            <p class="mb-2 text-xs font-medium text-muted-foreground">{m.import_preview()}</p>
            <pre class="overflow-x-auto text-xs font-mono">{previewLines.join("\n")}</pre>
          </div>
        {/if}

        <!-- Import button -->
        <div class="flex justify-end">
          <Button
            onclick={handleImport}
            disabled={taskQueue.isActive("ledger-import") || !fileContent.trim()}
          >
            <Upload class="mr-2 h-4 w-4" />
            {taskQueue.isActive("ledger-import") ? m.state_importing() : m.btn_import()}
          </Button>
        </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
