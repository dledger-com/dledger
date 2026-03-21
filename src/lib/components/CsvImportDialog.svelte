<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { importDrop } from "$lib/data/import-drop.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import { parseCsv, detectDelimiter } from "$lib/utils/csv-import.js";

  import { readFileAsText } from "$lib/utils/read-file-text.js";
  import {
    getDefaultPresetRegistry,
    detectColumns,
    transformGeneric,
    enqueueRecordImport,
    buildDedupIndex,
    markDuplicates,
    applyRuleTags,
    DATE_FORMATS,
    setBankStatementRules,
    setRevolutRules,
    setLaBanquePostaleRules,
    setN26Rules,
    type DateFormatId,
    type ColumnDetection,
    type PresetDetectionResult,
    type CsvRecord,
    type CsvFileHeader,
    type CsvCategorizationRule,
    type DedupIndex,
  } from "$lib/csv-presets/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";

  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { TransactionClassifier, type ClassificationResult } from "$lib/ml/classifier.js";
  import { classifyTransactions } from "$lib/csv-presets/categorize.js";
  import { ASSETS_BANK_IMPORT } from "$lib/accounts/paths.js";
  import AccountCombobox from "./AccountCombobox.svelte";
  import TagInput from "./TagInput.svelte";
  import CategorizationRulesEditor from "./CategorizationRulesEditor.svelte";
  import { serializeTags, parseTags, TAGS_META_KEY, tagColor } from "$lib/utils/tags.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Check from "lucide-svelte/icons/check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import BrainCircuit from "lucide-svelte/icons/brain-circuit";
  import Loader from "lucide-svelte/icons/loader";

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
  const presetRegistry = getDefaultPresetRegistry();

  // -- Wizard state --
  let step = $state<1 | 2 | 3>(1);

  // -- Step 1 state --
  let rawContent = $state("");
  let fileName = $state("");

  // -- Parsed data --
  let headers = $state<string[]>([]);
  let rows = $state<string[][]>([]);

  // -- Detection results --
  let detection = $state<ColumnDetection | null>(null);
  let presetResults = $state<PresetDetectionResult[]>([]);
  let bestPreset = $state<PresetDetectionResult | null>(null);

  // -- Step 2 state --
  let usePreset = $state(false);
  let selectedPresetId = $state("");
  let selectedPreset = $derived(presetResults.find(pr => pr.preset.id === selectedPresetId) ?? bestPreset);
  let delimiter = $state(",");
  let dateFormat = $state<DateFormatId>("YYYY-MM-DD");
  let dateColumn = $state("");
  let descriptionColumn = $state("");
  let currencyMode = $state<"fixed" | "column">("fixed");
  let fixedCurrency = $state("USD");
  let currencyColumn = $state("");
  let amountMode = $state<"single" | "split">("single");
  let amountColumn = $state("");
  let debitAmountColumn = $state("");
  let creditAmountColumn = $state("");
  let mainAccount = $state(ASSETS_BANK_IMPORT);
  let counterAccount = $state("Expenses:Uncategorized");
  let europeanNumbers = $state(false);
  let skipLines = $state(0);

  // -- File header (preset preamble) --
  let fileHeader = $state<CsvFileHeader | null>(null);

  // -- Categorization rules --
  let rules = $state<CsvCategorizationRule[]>([]);

  // -- Batch tags for import --
  let importTags = $state<string[]>([]);

  // -- Step 3 state --
  let previewRecords = $state<CsvRecord[]>([]);
  let previewWarnings = $state<string[]>([]);
  let duplicateFlags = $state<boolean[]>([]);
  let duplicateCount = $derived(duplicateFlags.filter(Boolean).length);
  let nonDuplicateCount = $derived(previewRecords.length - duplicateCount);

  // -- ML classification state --
  let mlSuggestions = $state<Map<number, ClassificationResult>>(new Map());
  let mlAccepted = $state<Set<number>>(new Set());
  let mlClassifying = $state(false);
  let mlEnabled = $derived(settings.settings.mlClassificationEnabled ?? false);
  let mlThreshold = $derived(settings.settings.mlConfidenceThreshold ?? 0.5);

  // -- Account list for inline editing --
  let accountPaths = $state<string[]>([]);

  async function fetchAccountPaths() {
    try {
      const backend = getBackend();
      const accounts = await backend.listAccounts();
      accountPaths = accounts.map((a) => a.full_name);
    } catch {
      accountPaths = [];
    }
  }

  function updateLineAccount(recIdx: number, lineIdx: number, newAccount: string) {
    const updated = [...previewRecords];
    const rec = { ...updated[recIdx], lines: [...updated[recIdx].lines] };
    rec.lines[lineIdx] = { ...rec.lines[lineIdx], account: newAccount };
    updated[recIdx] = rec;
    previewRecords = updated;
  }

  async function runMlClassification() {
    if (mlClassifying || previewRecords.length === 0) return;
    mlClassifying = true;

    const taskId = taskQueue.enqueue({
      key: "ml-classify",
      label: "Classifying transactions...",
      description: "Using ML to suggest account categories for uncategorized transactions",
      run: async (ctx) => {
        const classifier = new TransactionClassifier();
        try {
          await classifier.init(ctx.reportProgress, true);

          // Get all account paths from the backend
          const backend = getBackend();
          const accounts = await backend.listAccounts();
          const accountPaths = accounts.map((a) => a.full_name);

          const suggestions = await classifyTransactions(
            previewRecords,
            rules,
            accountPaths,
            classifier,
            mlThreshold,
            settings.settings.debugMode,
            backend,
          );

          mlSuggestions = suggestions;
          // Auto-accept all suggestions initially
          mlAccepted = new Set(suggestions.keys());

          const total = previewRecords.length;
          const classified = suggestions.size;
          return { summary: `Classified ${classified}/${total} transactions` };
        } finally {
          classifier.dispose();
          mlClassifying = false;
        }
      },
    });

    if (!taskId) {
      mlClassifying = false;
      toast.error("ML classification is already running");
    }
  }

  function toggleMlAccept(recIdx: number) {
    const next = new Set(mlAccepted);
    if (next.has(recIdx)) {
      next.delete(recIdx);
    } else {
      next.add(recIdx);
    }
    mlAccepted = next;
  }

  function applyMlSuggestions() {
    // Apply accepted ML suggestions to preview records
    const updated = [...previewRecords];
    for (const [idx, suggestion] of mlSuggestions) {
      if (!mlAccepted.has(idx)) continue;
      const rec = { ...updated[idx], lines: [...updated[idx].lines] };
      for (let j = 0; j < rec.lines.length; j++) {
        if (rec.lines[j].account.endsWith(":Uncategorized")) {
          rec.lines[j] = { ...rec.lines[j], account: suggestion.account };
        }
      }
      // Merge ML-suggested tags
      if (suggestion.tags && suggestion.tags.length > 0) {
        const existing = parseTags(rec.metadata?.[TAGS_META_KEY]);
        const merged = [...new Set([...existing, ...suggestion.tags])];
        rec.metadata = { ...rec.metadata, [TAGS_META_KEY]: serializeTags(merged) };
      }
      updated[idx] = rec;
    }
    previewRecords = updated;
    mlSuggestions = new Map();
    mlAccepted = new Set();
    toast.success("ML suggestions applied");
  }

  // Load rules from settings
  $effect(() => {
    rules = settings.settings.csvCategorizationRules ?? [];
  });

  function saveRules() {
    settings.update({ csvCategorizationRules: rules });
    setBankStatementRules(rules);
    setRevolutRules(rules);
    setLaBanquePostaleRules(rules);
    setN26Rules(rules);
  }

  async function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    fileName = file.name;
    rawContent = await readFileAsText(file);
  }

  function handleParse() {
    if (!rawContent.trim()) {
      toast.error("Please provide CSV content");
      return;
    }

    // Auto-detect delimiter from content
    delimiter = detectDelimiter(rawContent);

    const parsed = parseCsv(rawContent, delimiter);
    headers = parsed.headers;
    rows = parsed.rows;

    if (headers.length === 0) {
      toast.error("No headers found in CSV");
      return;
    }

    // Run detection
    const sampleRows = rows.slice(0, 20);
    detection = detectColumns(headers, sampleRows);

    // Detect presets
    setBankStatementRules(rules);
    setRevolutRules(rules);
    setLaBanquePostaleRules(rules);
    presetResults = presetRegistry.detectAll(headers, sampleRows);
    bestPreset = presetResults.length > 0 && presetResults[0].confidence >= 50
      ? presetResults[0]
      : null;

    // Pre-fill mapping from detection
    if (detection.dateColumn) dateColumn = detection.dateColumn;
    if (detection.dateFormat) dateFormat = detection.dateFormat;
    if (detection.descriptionColumn) descriptionColumn = detection.descriptionColumn;
    if (detection.amountColumn) {
      amountColumn = detection.amountColumn;
      amountMode = "single";
    }
    if (detection.debitAmountColumn && detection.creditAmountColumn) {
      debitAmountColumn = detection.debitAmountColumn;
      creditAmountColumn = detection.creditAmountColumn;
      amountMode = "split";
    }
    if (detection.currencyColumn) {
      currencyColumn = detection.currencyColumn;
      currencyMode = "column";
    }
    europeanNumbers = detection.europeanNumbers;

    // If best preset found, default to using it
    if (bestPreset) {
      usePreset = true;
      selectedPresetId = bestPreset.preset.id;

      // Extract file header metadata from preamble if preset supports it
      if (bestPreset.preset.parseFileHeader) {
        fileHeader = bestPreset.preset.parseFileHeader(headers, rows);
        if (fileHeader?.mainAccount) mainAccount = fileHeader.mainAccount;
      }
      if (!fileHeader?.mainAccount && bestPreset.preset.suggestedMainAccount) {
        mainAccount = bestPreset.preset.suggestedMainAccount;
      }
    }

    step = 2;
  }

  function handleReParse() {
    const parsed = parseCsv(rawContent, delimiter, usePreset ? 0 : skipLines);
    headers = parsed.headers;
    rows = parsed.rows;
  }

  function shouldAutoSkip(records: CsvRecord[]): boolean {
    const nonDupCount = records.length - duplicateFlags.filter(Boolean).length;
    if (nonDupCount > 0) return false;
    if (importDrop.batchActive) {
      toast.info(
        records.length === 0
          ? `Skipped ${fileName}: no entries found`
          : `Skipped ${fileName}: all ${records.length} entries are duplicates`,
      );
      importDrop.skipFile();
    } else {
      open = false;
      toast.info(
        records.length === 0
          ? `No entries found in ${fileName}`
          : `All ${records.length} entries in ${fileName} are duplicates`,
      );
    }
    return true;
  }

  async function generatePreview(autoSkipOnly = false) {
    if (usePreset && selectedPresetId) {
      const preset = presetRegistry.getById(selectedPresetId);
      if (preset) {
        const records = preset.transform(headers, rows);
        if (records) {
          // Apply main account override if user changed it
          const defaultMainAccount = fileHeader?.mainAccount;
          if (defaultMainAccount && mainAccount !== defaultMainAccount) {
            for (const rec of records) {
              for (const line of rec.lines) {
                if (line.account === defaultMainAccount) line.account = mainAccount;
              }
            }
          }
          previewRecords = records;
          previewWarnings = [];
          await detectDuplicates(records);
          if (shouldAutoSkip(records)) return;
          if (autoSkipOnly) return;
          fetchAccountPaths();
          step = 3;
          return;
        } else {
          toast.error("Preset transform failed. Try manual mapping.");
          return;
        }
      }
    }

    // Manual mapping
    const result = transformGeneric(headers, rows, {
      dateColumn,
      dateFormat,
      descriptionColumn: descriptionColumn || undefined,
      amountColumn: amountMode === "single" ? amountColumn : undefined,
      debitAmountColumn: amountMode === "split" ? debitAmountColumn : undefined,
      creditAmountColumn: amountMode === "split" ? creditAmountColumn : undefined,
      currencyColumn: currencyMode === "column" ? currencyColumn : undefined,
      fixedCurrency: currencyMode === "fixed" ? fixedCurrency : undefined,
      mainAccount,
      counterAccount,
      europeanNumbers,
    });

    previewRecords = result.records;
    previewWarnings = result.warnings;
    await detectDuplicates(result.records);
    if (shouldAutoSkip(result.records)) return;
    if (autoSkipOnly) return;
    fetchAccountPaths();
    step = 3;
  }

  async function detectDuplicates(records: CsvRecord[]) {
    try {
      const backend = getBackend();
      const presetId = usePreset && selectedPresetId ? selectedPresetId : undefined;
      const index = await buildDedupIndex(backend, records, presetId);
      duplicateFlags = markDuplicates(records, presetId, index);
    } catch {
      // Dedup detection is non-critical; proceed without it
      duplicateFlags = records.map(() => false);
    }
  }

  function doImport() {
    // Merge batch tags + rule tags into records before import
    const recordsSnapshot = [...previewRecords];
    if (importTags.length > 0) {
      for (const rec of recordsSnapshot) {
        const existing = parseTags(rec.metadata?.[TAGS_META_KEY]);
        const merged = [...new Set([...existing, ...importTags])];
        rec.metadata = { ...rec.metadata, [TAGS_META_KEY]: serializeTags(merged) };
      }
    }
    applyRuleTags(recordsSnapshot, rules);

    const presetIdSnapshot = usePreset && selectedPresetId ? selectedPresetId : undefined;
    const fileHeaderSnapshot = fileHeader;
    const mainAccountSnapshot = mainAccount;

    const taskId = enqueueRecordImport({
      key: "csv-import",
      label: "CSV Import",
      records: recordsSnapshot,
      presetId: presetIdSnapshot,
      postImport: async (backend, result) => {
        // Store account metadata from file header if available
        if (fileHeaderSnapshot?.accountMetadata && mainAccountSnapshot) {
          try {
            const accounts = await backend.listAccounts();
            const acct = accounts.find((a) => a.full_name === mainAccountSnapshot);
            if (acct) {
              await backend.setAccountMetadata(acct.id, fileHeaderSnapshot.accountMetadata);
            }
          } catch {
            // Account metadata is non-critical
          }
        }

        // Create balance assertion from file header if available
        if (fileHeaderSnapshot?.balanceDate && fileHeaderSnapshot?.balanceAmount && fileHeaderSnapshot?.balanceCurrency) {
          try {
            const accounts = await backend.listAccounts();
            const acct = accounts.find((a) => a.full_name === mainAccountSnapshot);
            if (acct) {
              await backend.createBalanceAssertion({
                id: uuidv7(),
                account_id: acct.id,
                date: fileHeaderSnapshot.balanceDate,
                currency: fileHeaderSnapshot.balanceCurrency,
                expected_balance: fileHeaderSnapshot.balanceAmount,
                is_passing: true,
                actual_balance: null,
                is_strict: false,
                include_subaccounts: false,
              });
              result.balance_assertion_created = true;
            }
          } catch {
            // Balance assertion is non-critical
          }
        }
      },
      rateConfig: settings.buildRateConfig(),
      hiddenCurrencies: getHiddenCurrencySet(),
    });

    if (taskId) {
      open = false;
    } else {
      toast.error("An import is already in progress");
    }
  }

  function resetDialog() {
    step = 1;
    rawContent = "";
    fileName = "";
    headers = [];
    rows = [];
    detection = null;
    presetResults = [];
    bestPreset = null;
    usePreset = false;
    selectedPresetId = "";
    fileHeader = null;
    skipLines = 0;
    previewRecords = [];
    previewWarnings = [];
    duplicateFlags = [];
    mlSuggestions = new Map();
    mlAccepted = new Set();
    mlClassifying = false;
    accountPaths = [];
    importTags = [];
  }

  // Auto-advance to step 2 when opened with initial content (drag-and-drop),
  // or reset state on manual open. We don't reset on close to avoid flashing
  // step 1 during the dialog's CSS exit animation.
  $effect.pre(() => {
    if (open && initialContent) {
      untrack(() => resetDialog());
      rawContent = initialContent;
      fileName = initialFileName;
      untrack(() => handleParse());
      // In batch mode, auto-generate preview to trigger duplicate detection
      if (importDrop.batchActive) {
        untrack(() => generatePreview(true));
      }
    } else if (open) {
      untrack(() => resetDialog());
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>
        {#if step === 1}
          CSV Import — Upload
        {:else if step === 2}
          CSV Import — Format & Mapping
        {:else}
          CSV Import — Preview & Import
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {#if step === 1}
          Upload a CSV file or paste content directly.
        {:else if step === 2}
          Configure how columns map to journal entries.
        {:else}
          Review entries before importing.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <!-- Step 1: Upload -->
    {#if step === 1}
      <div class="space-y-4">
        <div class="flex items-center gap-4">
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            <Upload class="h-4 w-4" />
            <span>{fileName || "Choose file"}</span>
            <input type="file" accept=".csv,.tsv,.txt" class="hidden" onchange={handleFileChange} />
          </label>
          <div class="flex items-center gap-2">
            <label for="csv-delimiter" class="text-sm">Delimiter:</label>
            <select
              id="csv-delimiter"
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
              bind:value={delimiter}
            >
              <option value=",">, (comma)</option>
              <option value=";">; (semicolon)</option>
              <option value="&#9">Tab</option>
            </select>
          </div>
        </div>
        <textarea
          class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Or paste CSV content here..."
          bind:value={rawContent}
        ></textarea>
        <div class="flex justify-end">
          <Button onclick={handleParse} disabled={!rawContent.trim()}>
            <FileText class="mr-2 h-4 w-4" /> Parse & Continue
          </Button>
        </div>
      </div>
    {/if}

    <!-- Step 2: Format & Mapping -->
    {#if step === 2}
      <div class="space-y-4">
        <!-- Preset detection banner -->
        {#if bestPreset}
          <div class="rounded-md border bg-muted/50 p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium">
                  Detected format: <strong>{selectedPreset?.preset.name ?? bestPreset.preset.name}</strong>
                  <Badge variant="secondary" class="ml-1">{selectedPreset?.confidence ?? bestPreset.confidence}% confidence</Badge>
                </p>
                <p class="text-xs text-muted-foreground mt-1">{selectedPreset?.preset.description ?? bestPreset.preset.description}</p>
              </div>
            </div>
            <div class="flex flex-wrap gap-1.5">
              {#each presetResults as pr}
                <Button
                  size="sm"
                  variant={usePreset && selectedPresetId === pr.preset.id ? "default" : "outline"}
                  class="text-xs h-7"
                  onclick={() => {
                    usePreset = true;
                    selectedPresetId = pr.preset.id;
                    if (pr.preset.parseFileHeader) {
                      fileHeader = pr.preset.parseFileHeader(headers, rows);
                      if (fileHeader?.mainAccount) mainAccount = fileHeader.mainAccount;
                    } else {
                      fileHeader = null;
                    }
                    if (!fileHeader?.mainAccount && pr.preset.suggestedMainAccount) {
                      mainAccount = pr.preset.suggestedMainAccount;
                    }
                  }}
                >
                  {pr.preset.name} ({pr.confidence}%)
                </Button>
              {/each}
              <Button
                size="sm"
                variant={!usePreset ? "default" : "outline"}
                class="text-xs h-7"
                onclick={() => { usePreset = false; mainAccount = ASSETS_BANK_IMPORT; }}
              >
                Manual Mapping
              </Button>
            </div>
          </div>
        {/if}

        <!-- File header info card (preset mode with preamble metadata) -->
        {#if usePreset && fileHeader}
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">File Header</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {#if fileHeader.accountMetadata?.accountID}
                <div>
                  <span class="text-xs text-muted-foreground">Account #</span>
                  <p class="font-mono text-xs">{fileHeader.accountMetadata.accountID}</p>
                </div>
              {/if}
              {#if fileHeader.balanceCurrency}
                <div>
                  <span class="text-xs text-muted-foreground">Currency</span>
                  <p class="font-mono text-xs">{fileHeader.balanceCurrency}</p>
                </div>
              {/if}
              {#if fileHeader.balanceDate}
                <div>
                  <span class="text-xs text-muted-foreground">Balance Date</span>
                  <p class="font-mono text-xs">{fileHeader.balanceDate}</p>
                </div>
              {/if}
              {#if fileHeader.balanceAmount}
                <div>
                  <span class="text-xs text-muted-foreground">Balance</span>
                  <p class="font-mono text-xs">{fileHeader.balanceAmount} {fileHeader.balanceCurrency ?? ""}</p>
                </div>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Editable main account (preset mode) -->
        {#if usePreset}
          <div class="space-y-1">
            <label for="d-presetMainAcct" class="text-sm font-medium">Main Account</label>
            <Input id="d-presetMainAcct" bind:value={mainAccount} placeholder="Assets:Bank:MyBank:Checking" />
          </div>
        {/if}

        <!-- Manual mapping (shown when not using preset) -->
        {#if !usePreset}
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div class="space-y-1">
              <label for="d-skipLines" class="text-sm font-medium">Skip Header Lines</label>
              <Input
                id="d-skipLines"
                type="number"
                min="0"
                bind:value={skipLines}
                onchange={handleReParse}
              />
            </div>
            <div class="space-y-1">
              <label for="d-delimiter" class="text-sm font-medium">Delimiter</label>
              <select
                id="d-delimiter"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                bind:value={delimiter}
                onchange={handleReParse}
              >
                <option value=",">, (comma)</option>
                <option value=";">; (semicolon)</option>
                <option value="&#9">Tab</option>
              </select>
            </div>
            <div class="space-y-1">
              <label for="d-dateFormat" class="text-sm font-medium">
                Date Format
                {#if detection?.dateFormat}<Badge variant="outline" class="ml-1 text-xs">auto</Badge>{/if}
              </label>
              <select
                id="d-dateFormat"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                bind:value={dateFormat}
              >
                {#each DATE_FORMATS as fmt}
                  <option value={fmt.id}>{fmt.label} ({fmt.example})</option>
                {/each}
              </select>
            </div>
            <div class="space-y-1">
              <label for="d-dateCol" class="text-sm font-medium">
                Date Column *
                {#if detection?.dateColumn}<Badge variant="outline" class="ml-1 text-xs">auto</Badge>{/if}
              </label>
              <select
                id="d-dateCol"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                bind:value={dateColumn}
              >
                <option value="">-- select --</option>
                {#each headers as h}
                  <option value={h}>{h}</option>
                {/each}
              </select>
            </div>
            <div class="space-y-1">
              <label for="d-descCol" class="text-sm font-medium">
                Description Column
                {#if detection?.descriptionColumn}<Badge variant="outline" class="ml-1 text-xs">auto</Badge>{/if}
              </label>
              <select
                id="d-descCol"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                bind:value={descriptionColumn}
              >
                <option value="">-- none --</option>
                {#each headers as h}
                  <option value={h}>{h}</option>
                {/each}
              </select>
            </div>
            <div class="space-y-1">
              <label for="d-currMode" class="text-sm font-medium">Currency</label>
              <select
                id="d-currMode"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                bind:value={currencyMode}
              >
                <option value="fixed">Fixed value</option>
                <option value="column">From column</option>
              </select>
            </div>
            {#if currencyMode === "fixed"}
              <div class="space-y-1">
                <label for="d-fixedCurr" class="text-sm font-medium">Currency Code</label>
                <Input id="d-fixedCurr" bind:value={fixedCurrency} placeholder="USD" />
              </div>
            {:else}
              <div class="space-y-1">
                <label for="d-currCol" class="text-sm font-medium">Currency Column</label>
                <select
                  id="d-currCol"
                  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  bind:value={currencyColumn}
                >
                  <option value="">-- select --</option>
                  {#each headers as h}
                    <option value={h}>{h}</option>
                  {/each}
                </select>
              </div>
            {/if}
          </div>

          <!-- Amount mode -->
          <div class="space-y-3">
            <div class="flex items-center gap-4">
              <span class="text-sm font-medium">Amount Mode:</span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant={amountMode === "single" ? "default" : "outline"}
                  onclick={() => { amountMode = "single"; }}
                >
                  Single column (signed)
                </Button>
                <Button
                  size="sm"
                  variant={amountMode === "split" ? "default" : "outline"}
                  onclick={() => { amountMode = "split"; }}
                >
                  Separate debit/credit
                </Button>
              </div>
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" bind:checked={europeanNumbers} class="rounded" />
                European numbers (1.234,56)
              </label>
            </div>

            {#if amountMode === "single"}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div class="space-y-1">
                  <label for="d-amtCol" class="text-sm font-medium">
                    Amount Column *
                    {#if detection?.amountColumn}<Badge variant="outline" class="ml-1 text-xs">auto</Badge>{/if}
                  </label>
                  <select
                    id="d-amtCol"
                    class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    bind:value={amountColumn}
                  >
                    <option value="">-- select --</option>
                    {#each headers as h}
                      <option value={h}>{h}</option>
                    {/each}
                  </select>
                </div>
                <div class="space-y-1">
                  <label for="d-mainAcct" class="text-sm font-medium">Main Account</label>
                  <Input id="d-mainAcct" bind:value={mainAccount} placeholder="Assets:Bank:MyBank:Checking" />
                </div>
                <div class="space-y-1">
                  <label for="d-counterAcct" class="text-sm font-medium">Counter Account</label>
                  <Input id="d-counterAcct" bind:value={counterAccount} placeholder="Expenses:Uncategorized" />
                </div>
              </div>
            {:else}
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="space-y-1">
                  <label for="d-debitCol" class="text-sm font-medium">Debit Column</label>
                  <select
                    id="d-debitCol"
                    class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    bind:value={debitAmountColumn}
                  >
                    <option value="">-- select --</option>
                    {#each headers as h}
                      <option value={h}>{h}</option>
                    {/each}
                  </select>
                </div>
                <div class="space-y-1">
                  <label for="d-creditCol" class="text-sm font-medium">Credit Column</label>
                  <select
                    id="d-creditCol"
                    class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    bind:value={creditAmountColumn}
                  >
                    <option value="">-- select --</option>
                    {#each headers as h}
                      <option value={h}>{h}</option>
                    {/each}
                  </select>
                </div>
                <div class="space-y-1">
                  <label for="d-mainAcct2" class="text-sm font-medium">Main Account</label>
                  <Input id="d-mainAcct2" bind:value={mainAccount} placeholder="Assets:Bank:MyBank:Checking" />
                </div>
                <div class="space-y-1">
                  <label for="d-counterAcct2" class="text-sm font-medium">Counter Account</label>
                  <Input id="d-counterAcct2" bind:value={counterAccount} placeholder="Expenses:Uncategorized" />
                </div>
              </div>
            {/if}
          </div>

        {/if}

        <!-- Categorization Rules (always visible in step 2) -->
        <CategorizationRulesEditor
          {rules}
          onchange={(updated) => { rules = updated; saveRules(); }}
        />

        <!-- Preview table (first 5 rows) -->
        {#if rows.length > 0}
          <details>
            <summary class="text-sm text-muted-foreground cursor-pointer">CSV Preview ({rows.length} data rows)</summary>
            <div class="overflow-x-auto mt-2 max-h-40">
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    {#each headers as h}
                      <Table.Head class="whitespace-nowrap text-xs">{h}</Table.Head>
                    {/each}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each rows.slice(0, 5) as row}
                    <Table.Row>
                      {#each headers as _, idx}
                        <Table.Cell class="font-mono text-xs py-1">{row[idx] ?? ""}</Table.Cell>
                      {/each}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          </details>
        {/if}

        <div class="flex justify-between">
          <Button variant="outline" onclick={() => { step = 1; }}>Back</Button>
          <Button onclick={() => generatePreview()} disabled={!usePreset && !dateColumn}>
            Preview &rarr;
          </Button>
        </div>
      </div>
    {/if}

    <!-- Step 3: Preview & Import -->
    {#if step === 3}
      <div class="space-y-4">
          <!-- Preview -->
          <div class="flex items-center justify-between">
            <p class="text-sm">
              <strong>{nonDuplicateCount}</strong> entries to import
              {#if duplicateCount > 0}
                <Badge variant="secondary" class="ml-2">{duplicateCount} duplicates (will skip)</Badge>
              {/if}
              {#if previewWarnings.length > 0}
                <Badge variant="destructive" class="ml-2">{previewWarnings.length} warnings</Badge>
              {/if}
            </p>
            <div class="flex items-center gap-2">
              {#if mlSuggestions.size > 0}
                <Badge variant="outline" class="text-xs">{mlSuggestions.size} ML suggestions</Badge>
                <Button size="sm" variant="default" class="h-7 text-xs" onclick={applyMlSuggestions}>
                  Accept {mlAccepted.size} suggestions
                </Button>
              {/if}
              {#if mlEnabled}
                <Button
                  size="sm"
                  variant="outline"
                  class="h-7 text-xs {mlClassifying ? 'animate-pulse border-primary/60 disabled:opacity-80' : ''}"
                  onclick={runMlClassification}
                  disabled={mlClassifying || taskQueue.isActive("ml-classify")}
                >
                  {#if mlClassifying}
                    <Loader class="h-3 w-3 mr-1 animate-spin" />
                  {:else}
                    <BrainCircuit class="h-3 w-3 mr-1" />
                  {/if}
                  {mlClassifying ? "Classifying..." : "Classify with AI"}
                </Button>
              {/if}
            </div>
          </div>

          <!-- Batch tags for all imported entries -->
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground shrink-0">Tags for all:</span>
            <TagInput tags={importTags} onchange={(t) => { importTags = t; }} class="flex-1" />
          </div>

          {#if previewWarnings.length > 0}
            <details>
              <summary class="text-xs text-muted-foreground cursor-pointer">Show warnings</summary>
              <div class="max-h-24 overflow-y-auto mt-1 space-y-0.5">
                {#each previewWarnings.slice(0, 20) as w}
                  <p class="text-xs text-muted-foreground">{w}</p>
                {/each}
              </div>
            </details>
          {/if}

          <!-- Entry preview table -->
          <div class="overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head class="w-24">Date</Table.Head>
                  <Table.Head>Description</Table.Head>
                  <Table.Head class="min-w-[260px]">Line Items</Table.Head>
                  <Table.Head class="w-16 text-center">Balance</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each previewRecords.slice(0, 50) as rec, recIdx}
                  {@const sum = rec.lines.reduce((s, l) => s + parseFloat(l.amount), 0)}
                  {@const balanced = Math.abs(sum) < 0.0001}
                  {@const dup = duplicateFlags[recIdx] ?? false}
                  <Table.Row class={dup ? "opacity-40" : ""}>
                    <Table.Cell class="font-mono text-xs">{rec.date}</Table.Cell>
                    {@const mlSuggestion = mlSuggestions.get(recIdx)}
                    {@const mlIsAccepted = mlAccepted.has(recIdx)}
                    {@const recTags = parseTags(rec.metadata?.[TAGS_META_KEY])}
                    <Table.Cell class="text-xs max-w-[250px] whitespace-normal">
                      <span>{rec.description}</span>
                      {#if dup}<Badge variant="outline" class="ml-1 text-xs">dup</Badge>{/if}
                      {#if recTags.length > 0}
                        <div class="flex flex-wrap gap-0.5 mt-0.5">
                          {#each recTags as tag}
                            <Badge variant="outline" class={tagColor(tag) + " border-transparent text-[10px] px-1 py-0"}>{tag}</Badge>
                          {/each}
                        </div>
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="text-xs whitespace-normal">
                      {#each rec.lines.slice(0, 4) as line, lineIdx}
                        <div class="flex gap-1 items-center">
                          <AccountCombobox
                            value={line.account}
                            accounts={accountPaths}
                            onchange={(v) => updateLineAccount(recIdx, lineIdx, v)}
                          />
                          <span class={parseFloat(line.amount) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                            {parseFloat(line.amount) >= 0 ? "+" : ""}{line.amount} {line.currency}
                          </span>
                        </div>
                      {/each}
                      {#if rec.lines.length > 4}
                        <span class="text-muted-foreground text-xs">+{rec.lines.length - 4} more</span>
                      {/if}
                      {#if mlSuggestion}
                        <button
                          class="flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded text-xs cursor-pointer {mlIsAccepted ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-muted text-muted-foreground line-through'}"
                          onclick={() => toggleMlAccept(recIdx)}
                          title={mlIsAccepted ? "Click to reject suggestion" : "Click to accept suggestion"}
                        >
                          <BrainCircuit class="h-3 w-3" />
                          <span class="font-mono truncate max-w-[140px]">{mlSuggestion.account}</span>
                          <Badge variant="outline" class="text-[10px] px-1 py-0 h-4">{Math.round(mlSuggestion.confidence * 100)}%</Badge>
                        </button>
                        {#if mlIsAccepted && mlSuggestion.tags && mlSuggestion.tags.length > 0}
                          <div class="flex flex-wrap gap-0.5 mt-0.5 ml-4">
                            {#each mlSuggestion.tags as tag}
                              <Badge variant="outline" class={tagColor(tag) + " border-transparent text-[10px] px-1 py-0 opacity-70"}>{tag}</Badge>
                            {/each}
                          </div>
                        {/if}
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="text-center">
                      {#if balanced}
                        <Check class="h-4 w-4 text-green-500 mx-auto" />
                      {:else}
                        <CircleAlert class="h-4 w-4 text-red-500 mx-auto" />
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/each}
                {#if previewRecords.length > 50}
                  <Table.Row>
                    <Table.Cell colspan={4} class="text-center text-xs text-muted-foreground py-2">
                      ... and {previewRecords.length - 50} more entries
                    </Table.Cell>
                  </Table.Row>
                {/if}
              </Table.Body>
            </Table.Root>
          </div>

          <div class="flex justify-between">
            <Button variant="outline" onclick={() => { step = 2; }}>Back</Button>
            {#if nonDuplicateCount === 0}
              {#if importDrop.batchActive}
                <Button variant="outline" onclick={() => importDrop.skipFile()}>Skip</Button>
              {:else}
                <Button variant="outline" onclick={() => { open = false; }}>Cancel</Button>
              {/if}
            {:else}
              <Button onclick={doImport} disabled={taskQueue.isActive("csv-import")}>
                {taskQueue.isActive("csv-import") ? "Importing..." : `Import ${nonDuplicateCount} entries`}
              </Button>
            {/if}
          </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
