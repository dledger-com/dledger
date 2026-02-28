<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";
  import { readFileAsText } from "$lib/utils/read-file-text.js";
  import { detectFormat, detectFormatFromFilename, formatLabel, type LedgerFormat } from "$lib/ledger-format.js";
  import { resolveIncludes, filterLedgerFiles } from "$lib/ledger-include.js";
  import { unzipSync, strFromU8 } from "fflate";
  import {
    findMissingRates,
    fetchHistoricalRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import type { LedgerImportResult } from "$lib/types/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";

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
  let submitting = $state(false);
  let result = $state<LedgerImportResult | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);
  let formatOverride = $state<LedgerFormat | null>(null);
  const fetchingMissingRates = $derived(taskQueue.isActive("rate-backfill:missing"));

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
          toast.error("No ledger files found in archive");
          fileContent = "";
          return;
        }
        const parts: string[] = [];
        for (const [name, content] of ledgerFiles) {
          parts.push(resolveIncludes(content, fileMap));
        }
        fileContent = parts.join("\n\n");
      } catch (err) {
        toast.error(`Failed to read zip: ${err}`);
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

  async function handleImport() {
    if (!fileContent.trim()) {
      toast.error("No ledger data to import");
      return;
    }

    submitting = true;
    result = null;
    missingRateRequests = [];

    try {
      result = await getBackend().importLedgerFile(fileContent, effectiveFormat ?? undefined);
      const parts = [`${result.transactions_imported} transaction(s) imported`];
      if (result.duplicates_skipped > 0) {
        parts.push(`${result.duplicates_skipped} duplicate(s) skipped`);
      }
      toast.success(parts.join(", "));

      if (result.transaction_currency_dates && result.transaction_currency_dates.length > 0) {
        const currencyDates = result.transaction_currency_dates.map(([currency, date]) => ({ currency, date }));
        const missing = await findMissingRates(
          getBackend(),
          settings.currency,
          currencyDates,
        );
        if (missing.length > 0) {
          missingRateRequests = missing;
        }
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      submitting = false;
    }
  }

  function handleFetchMissingRates() {
    const requests = [...missingRateRequests];
    taskQueue.enqueue({
      key: "rate-backfill:missing",
      label: `Fetch ${requests.reduce((sum, r) => sum + r.dates.length, 0)} missing rate(s)`,
      async run(ctx) {
        const result = await fetchHistoricalRates(
          getBackend(),
          requests,
          {
            baseCurrency: settings.currency,
            coingeckoApiKey: settings.coingeckoApiKey,
            finnhubApiKey: settings.finnhubApiKey,
            cryptoCompareApiKey: settings.cryptoCompareApiKey,
            dpriceEnabled: settings.settings.dpriceEnabled,
            dpriceUrl: settings.settings.dpriceUrl,
            onProgress: (fetched, total) => {
              ctx.reportProgress({ current: fetched, total });
            },
          },
        );
        missingRateRequests = [];

        if (result.failedCurrencies.length > 0) {
          const backend = getBackend();
          for (const code of result.failedCurrencies) {
            await backend.setCurrencyRateSource(code, "none", "auto");
            await markCurrencyHidden(backend, code);
          }
          showAutoHideToast(result.failedCurrencies);
        }

        if (result.errors.length > 0) {
          toast.warning(`Fetched ${result.fetched} rate(s) with ${result.errors.length} warning(s)`);
        } else {
          toast.success(`Fetched ${result.fetched} historical rate(s)`);
        }

        return { summary: `Fetched ${result.fetched} rate(s)`, data: result };
      },
    });
  }

  function resetDialog() {
    fileContent = "";
    fileName = null;
    fileCount = 0;
    result = null;
    missingRateRequests = [];
    formatOverride = null;
  }

  // Reset format override when file content changes (new file loaded)
  $effect(() => {
    fileContent;
    untrack(() => { formatOverride = null; });
  });

  // Reset on close
  $effect(() => {
    if (!open) resetDialog();
  });

  // Auto-advance when opened with initial content (drag-and-drop)
  $effect(() => {
    if (open && initialContent) {
      fileContent = initialContent;
      fileName = initialFileName;
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Plain-Text Accounting Import</Dialog.Title>
      <Dialog.Description>
        Import from ledger files (.ledger, .beancount, .journal, .hledger), a zip archive, or paste content directly.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      {#if !result}
        <!-- File picker -->
        <div class="flex items-center gap-4">
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            <Upload class="h-4 w-4" />
            <span>{fileName || "Choose file"}</span>
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
              <Badge variant="secondary">{fileCount} files</Badge>
            {/if}
          {/if}
        </div>

        {#if detectedFormat}
          <div class="flex items-center gap-3 rounded-md border p-3">
            <span class="text-sm text-muted-foreground">Detected format: <strong>{formatLabel(detectedFormat)}</strong></span>
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
            <p class="mb-2 text-xs font-medium text-muted-foreground">Preview (first 10 lines)</p>
            <pre class="overflow-x-auto text-xs font-mono">{previewLines.join("\n")}</pre>
          </div>
        {/if}

        <!-- Import button -->
        <div class="flex justify-end">
          <Button
            onclick={handleImport}
            disabled={submitting || !fileContent.trim()}
          >
            <Upload class="mr-2 h-4 w-4" />
            {submitting ? "Importing..." : "Import"}
          </Button>
        </div>
      {:else}
        <!-- Import Results -->
        <div class="rounded-md border bg-muted/50 p-4 space-y-3">
          <h4 class="text-sm font-semibold">Import Complete</h4>
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div class="text-center">
              <p class="text-2xl font-bold">{result.accounts_created}</p>
              <p class="text-xs text-muted-foreground">Accounts</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-bold">{result.currencies_created}</p>
              <p class="text-xs text-muted-foreground">Currencies</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-bold">{result.transactions_imported}</p>
              <p class="text-xs text-muted-foreground">Transactions</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-bold">{result.prices_imported}</p>
              <p class="text-xs text-muted-foreground">Prices</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-bold">{result.duplicates_skipped}</p>
              <p class="text-xs text-muted-foreground">Duplicates Skipped</p>
            </div>
          </div>

          {#if result.warnings.length > 0}
            <div>
              <p class="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                Warnings ({result.warnings.length})
              </p>
              <ul class="mt-1 max-h-40 overflow-y-auto text-xs text-muted-foreground">
                {#each result.warnings as warning}
                  <li class="py-0.5">{warning}</li>
                {/each}
              </ul>
            </div>
          {/if}

          <!-- Missing rates banner (inline) -->
          {#if missingRateRequests.length > 0}
            {@const totalMissing = missingRateRequests.reduce((sum, r) => sum + r.dates.length, 0)}
            <div class="rounded-md border border-amber-200 dark:border-amber-800 p-3 space-y-2">
              <p class="text-sm font-medium">Missing Historical Rates</p>
              <p class="text-xs text-muted-foreground">
                {totalMissing} historical rate(s) missing for {missingRateRequests.length} currency(ies).
              </p>
              <div class="flex flex-wrap gap-2">
                {#each missingRateRequests as req}
                  <Badge variant="secondary">{req.currency} ({req.dates.length} date{req.dates.length === 1 ? "" : "s"})</Badge>
                {/each}
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="outline" size="sm" onclick={() => { missingRateRequests = []; }}>Skip</Button>
                <Button size="sm" onclick={handleFetchMissingRates} disabled={fetchingMissingRates}>
                  {fetchingMissingRates ? "Fetching..." : "Fetch Now"}
                </Button>
              </div>
            </div>
          {/if}

          <div class="flex justify-end gap-2">
            <Button variant="outline" size="sm" href="/journal">View Journal</Button>
            <Button variant="outline" size="sm" href="/accounts">View Accounts</Button>
            <Button variant="outline" size="sm" onclick={() => { open = false; }}>Close</Button>
          </div>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
