<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import { parseCsv } from "$lib/utils/csv-import.js";
  import type { CsvImportResult } from "$lib/utils/csv-import.js";
  import {
    getDefaultPresetRegistry,
    detectColumns,
    transformGeneric,
    importRecords,
    DATE_FORMATS,
    setBankStatementRules,
    setRevolutRules,
    type DateFormatId,
    type ColumnDetection,
    type PresetDetectionResult,
    type CsvRecord,
    type CsvCategorizationRule,
  } from "$lib/csv-presets/index.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Plus from "lucide-svelte/icons/plus";
  import Check from "lucide-svelte/icons/check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";

  let { open = $bindable(false) }: { open: boolean } = $props();

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
  let mainAccount = $state("Assets:Bank:Import");
  let counterAccount = $state("Expenses:Uncategorized");
  let europeanNumbers = $state(false);

  // -- Categorization rules --
  let rules = $state<CsvCategorizationRule[]>([]);
  let newPattern = $state("");
  let newAccount = $state("");
  let showRules = $state(false);

  // -- Step 3 state --
  let previewRecords = $state<CsvRecord[]>([]);
  let previewWarnings = $state<string[]>([]);
  let importing = $state(false);
  let importResult = $state<CsvImportResult | null>(null);

  // Load rules from settings
  $effect(() => {
    rules = settings.settings.csvCategorizationRules ?? [];
  });

  function saveRules() {
    settings.update({ csvCategorizationRules: rules });
    setBankStatementRules(rules);
    setRevolutRules(rules);
  }

  function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    fileName = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      rawContent = reader.result as string;
    };
    reader.readAsText(file);
  }

  function handleParse() {
    if (!rawContent.trim()) {
      toast.error("Please provide CSV content");
      return;
    }

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
    }

    step = 2;
  }

  function handleReParse() {
    const parsed = parseCsv(rawContent, delimiter);
    headers = parsed.headers;
    rows = parsed.rows;
  }

  function generatePreview() {
    if (usePreset && selectedPresetId) {
      const preset = presetRegistry.getById(selectedPresetId);
      if (preset) {
        const records = preset.transform(headers, rows);
        if (records) {
          previewRecords = records;
          previewWarnings = [];
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
    step = 3;
  }

  async function doImport() {
    importing = true;
    importResult = null;
    try {
      const presetId = usePreset && selectedPresetId ? selectedPresetId : undefined;
      importResult = await importRecords(getBackend(), previewRecords, presetId);
      toast.success(`Imported ${importResult.entries_created} entries`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      importing = false;
    }
  }

  function addRule() {
    if (!newPattern.trim() || !newAccount.trim()) return;
    rules = [...rules, { id: uuidv7(), pattern: newPattern.trim(), account: newAccount.trim() }];
    newPattern = "";
    newAccount = "";
    saveRules();
  }

  function removeRule(id: string) {
    rules = rules.filter((r) => r.id !== id);
    saveRules();
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
    previewRecords = [];
    previewWarnings = [];
    importResult = null;
  }

  // Reset on close
  $effect(() => {
    if (!open) resetDialog();
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-4xl max-h-[90vh] overflow-y-auto">
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
          <div class="rounded-md border bg-muted/50 p-4">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium">
                  This looks like a <strong>{bestPreset.preset.name}</strong>
                  <Badge variant="secondary" class="ml-1">{bestPreset.confidence}% confidence</Badge>
                </p>
                <p class="text-xs text-muted-foreground mt-1">{bestPreset.preset.description}</p>
              </div>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant={usePreset ? "default" : "outline"}
                  onclick={() => { usePreset = true; selectedPresetId = bestPreset!.preset.id; }}
                >
                  Use Preset
                </Button>
                <Button
                  size="sm"
                  variant={!usePreset ? "default" : "outline"}
                  onclick={() => { usePreset = false; }}
                >
                  Manual Mapping
                </Button>
              </div>
            </div>
            {#if presetResults.length > 1}
              <details class="mt-2">
                <summary class="text-xs text-muted-foreground cursor-pointer">Other detected formats</summary>
                <div class="flex flex-wrap gap-1 mt-1">
                  {#each presetResults.slice(1) as pr}
                    <Button
                      size="sm"
                      variant="ghost"
                      class="text-xs h-6"
                      onclick={() => { usePreset = true; selectedPresetId = pr.preset.id; }}
                    >
                      {pr.preset.name} ({pr.confidence}%)
                    </Button>
                  {/each}
                </div>
              </details>
            {/if}
          </div>
        {/if}

        <!-- Manual mapping (shown when not using preset) -->
        {#if !usePreset}
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                  <Input id="d-mainAcct" bind:value={mainAccount} placeholder="Assets:Bank:Import" />
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
                  <Input id="d-mainAcct2" bind:value={mainAccount} placeholder="Assets:Bank:Import" />
                </div>
                <div class="space-y-1">
                  <label for="d-counterAcct2" class="text-sm font-medium">Counter Account</label>
                  <Input id="d-counterAcct2" bind:value={counterAccount} placeholder="Expenses:Uncategorized" />
                </div>
              </div>
            {/if}
          </div>

          <!-- Categorization Rules -->
          <div class="rounded-md border p-4 space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-sm font-semibold">Categorization Rules</h4>
              <Button size="sm" variant="ghost" onclick={() => { showRules = !showRules; }}>
                {showRules ? "Hide" : "Show"} ({rules.length} rules)
              </Button>
            </div>
            {#if showRules}
              <p class="text-xs text-muted-foreground">
                Match keywords in descriptions to auto-assign counterparty accounts. First match wins.
              </p>
              {#if rules.length > 0}
                <div class="space-y-1 max-h-40 overflow-y-auto">
                  {#each rules as rule}
                    <div class="flex items-center gap-2 text-sm">
                      <Badge variant="outline" class="font-mono">{rule.pattern}</Badge>
                      <span class="text-muted-foreground">&rarr;</span>
                      <span class="font-mono text-xs">{rule.account}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        class="h-6 w-6 p-0 ml-auto"
                        onclick={() => removeRule(rule.id)}
                      >
                        <Trash2 class="h-3 w-3" />
                      </Button>
                    </div>
                  {/each}
                </div>
              {/if}
              <div class="flex gap-2">
                <Input bind:value={newPattern} placeholder="Keyword (e.g. coffee)" class="flex-1 h-8 text-sm" />
                <Input bind:value={newAccount} placeholder="Account (e.g. Expenses:Coffee)" class="flex-1 h-8 text-sm" />
                <Button size="sm" class="h-8" onclick={addRule} disabled={!newPattern.trim() || !newAccount.trim()}>
                  <Plus class="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
            {/if}
          </div>
        {/if}

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
          <Button onclick={generatePreview} disabled={!usePreset && !dateColumn}>
            Preview &rarr;
          </Button>
        </div>
      </div>
    {/if}

    <!-- Step 3: Preview & Import -->
    {#if step === 3}
      <div class="space-y-4">
        {#if importResult}
          <!-- Import Results -->
          <div class="rounded-md border bg-muted/50 p-4 space-y-3">
            <h4 class="text-sm font-semibold">Import Complete</h4>
            <div class="grid grid-cols-3 gap-4">
              <div class="text-center">
                <p class="text-2xl font-bold">{importResult.entries_created}</p>
                <p class="text-xs text-muted-foreground">Entries</p>
              </div>
              <div class="text-center">
                <p class="text-2xl font-bold">{importResult.accounts_created}</p>
                <p class="text-xs text-muted-foreground">Accounts Created</p>
              </div>
              <div class="text-center">
                <p class="text-2xl font-bold">{importResult.currencies_created}</p>
                <p class="text-xs text-muted-foreground">Currencies Created</p>
              </div>
            </div>
            {#if importResult.warnings.length > 0}
              <div>
                <h4 class="text-xs font-semibold mb-1">Warnings ({importResult.warnings.length})</h4>
                <div class="max-h-24 overflow-y-auto space-y-0.5">
                  {#each importResult.warnings.slice(0, 20) as w}
                    <p class="text-xs text-muted-foreground">{w}</p>
                  {/each}
                  {#if importResult.warnings.length > 20}
                    <p class="text-xs text-muted-foreground">... and {importResult.warnings.length - 20} more</p>
                  {/if}
                </div>
              </div>
            {/if}
            <div class="flex justify-end gap-2">
              <Button variant="outline" size="sm" onclick={() => { open = false; }}>Close</Button>
            </div>
          </div>
        {:else}
          <!-- Preview -->
          <div class="flex items-center justify-between">
            <p class="text-sm">
              <strong>{previewRecords.length}</strong> entries to import
              {#if previewWarnings.length > 0}
                <Badge variant="destructive" class="ml-2">{previewWarnings.length} warnings</Badge>
              {/if}
            </p>
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
          <div class="overflow-x-auto max-h-[40vh]">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head class="w-24">Date</Table.Head>
                  <Table.Head>Description</Table.Head>
                  <Table.Head>Line Items</Table.Head>
                  <Table.Head class="w-16 text-center">Balance</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each previewRecords.slice(0, 50) as rec}
                  {@const sum = rec.lines.reduce((s, l) => s + parseFloat(l.amount), 0)}
                  {@const balanced = Math.abs(sum) < 0.0001}
                  <Table.Row>
                    <Table.Cell class="font-mono text-xs">{rec.date}</Table.Cell>
                    <Table.Cell class="text-xs max-w-[200px] truncate">{rec.description}</Table.Cell>
                    <Table.Cell class="text-xs">
                      {#each rec.lines.slice(0, 4) as line}
                        <div class="flex gap-1">
                          <span class="font-mono text-muted-foreground truncate max-w-[160px]">{line.account}</span>
                          <span class={parseFloat(line.amount) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                            {parseFloat(line.amount) >= 0 ? "+" : ""}{line.amount} {line.currency}
                          </span>
                        </div>
                      {/each}
                      {#if rec.lines.length > 4}
                        <span class="text-muted-foreground text-xs">+{rec.lines.length - 4} more</span>
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
            <Button onclick={doImport} disabled={importing || previewRecords.length === 0}>
              {importing ? "Importing..." : `Import ${previewRecords.length} entries`}
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
