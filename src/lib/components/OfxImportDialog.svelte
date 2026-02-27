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
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import { readFileAsText } from "$lib/utils/read-file-text.js";
  import type { CsvImportResult } from "$lib/utils/csv-import.js";
  import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
  import {
    importRecords,
    buildDedupIndex,
    isDuplicate,
    type CsvRecord,
    type CsvFileHeader,
    type DedupIndex,
  } from "$lib/csv-presets/index.js";
  import {
    parseOfx,
    convertOfxToRecords,
    suggestMainAccount,
    type OfxStatement,
    type OfxParseResult,
  } from "$lib/ofx/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { TransactionClassifier, type ClassificationResult } from "$lib/ml/classifier.js";
  import { classifyTransactions } from "$lib/csv-presets/categorize.js";
  import { ASSETS_BANK_IMPORT } from "$lib/accounts/paths.js";
  import AccountCombobox from "./AccountCombobox.svelte";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import GripVertical from "lucide-svelte/icons/grip-vertical";
  import Plus from "lucide-svelte/icons/plus";
  import Check from "lucide-svelte/icons/check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import BrainCircuit from "lucide-svelte/icons/brain-circuit";

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

  // -- Wizard state --
  let step = $state<1 | 2>(1);

  // -- Step 1 state --
  let rawContent = $state("");
  let fileName = $state("");

  // -- Parsed OFX data --
  let parseResult = $state<OfxParseResult | null>(null);
  let selectedStatement = $state<OfxStatement | null>(null);
  let mainAccount = $state(ASSETS_BANK_IMPORT);

  // -- Categorization rules --
  let rules = $state<CsvCategorizationRule[]>([]);
  let newPattern = $state("");
  let newAccount = $state("");
  let showRules = $state(false);

  // -- Step 2 state --
  let previewRecords = $state<CsvRecord[]>([]);
  let previewWarnings = $state<string[]>([]);
  let fileHeader = $state<CsvFileHeader | null>(null);
  let importing = $state(false);
  let importResult = $state<CsvImportResult | null>(null);
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
          const backend = getBackend();
          const accounts = await backend.listAccounts();
          const accountPaths = accounts.map((a) => a.full_name);

          const suggestions = await classifyTransactions(
            previewRecords, rules, accountPaths, classifier, mlThreshold,
            settings.settings.debugMode,
          );
          mlSuggestions = suggestions;
          mlAccepted = new Set(suggestions.keys());
          return { summary: `Classified ${suggestions.size}/${previewRecords.length} transactions` };
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
    if (next.has(recIdx)) next.delete(recIdx); else next.add(recIdx);
    mlAccepted = next;
  }

  function applyMlSuggestions() {
    const updated = [...previewRecords];
    for (const [idx, suggestion] of mlSuggestions) {
      if (!mlAccepted.has(idx)) continue;
      const rec = { ...updated[idx], lines: [...updated[idx].lines] };
      for (let j = 0; j < rec.lines.length; j++) {
        if (rec.lines[j].account.endsWith(":Uncategorized")) {
          rec.lines[j] = { ...rec.lines[j], account: suggestion.account };
        }
      }
      updated[idx] = rec;
    }
    previewRecords = updated;
    mlSuggestions = new Map();
    mlAccepted = new Set();
    toast.success("ML suggestions applied");
  }

  // -- Derived info --
  let txCount = $derived(selectedStatement?.transactions.length ?? 0);
  let dateRange = $derived.by(() => {
    if (!selectedStatement || selectedStatement.transactions.length === 0) return null;
    const dates = selectedStatement.transactions
      .map((tx) => tx.dtPosted.slice(0, 8))
      .sort();
    const fmt = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return { from: fmt(dates[0]), to: fmt(dates[dates.length - 1]) };
  });

  // Load rules from settings
  $effect(() => {
    rules = settings.settings.csvCategorizationRules ?? [];
  });

  function saveRules() {
    settings.update({ csvCategorizationRules: rules });
  }

  async function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    fileName = file.name;
    rawContent = await readFileAsText(file);
    handleParse();
  }

  function handleParse() {
    if (!rawContent.trim()) {
      toast.error("Please provide OFX content");
      return;
    }

    parseResult = parseOfx(rawContent);

    if (parseResult.statements.length === 0) {
      toast.error(parseResult.warnings[0] ?? "No statement data found in file");
      return;
    }

    // Auto-select first statement
    selectedStatement = parseResult.statements[0];
    mainAccount = suggestMainAccount(selectedStatement);
  }

  async function generatePreview() {
    if (!selectedStatement) return;

    const result = convertOfxToRecords(selectedStatement, {
      mainAccount,
      rules,
    });

    previewRecords = result.records;
    previewWarnings = result.warnings;
    fileHeader = result.fileHeader;

    await detectDuplicates(result.records);
    fetchAccountPaths();
    step = 2;
  }

  async function detectDuplicates(records: CsvRecord[]) {
    try {
      const backend = getBackend();
      const index = await buildDedupIndex(backend, records, "ofx-import");
      duplicateFlags = records.map((rec) => isDuplicate(rec, "ofx-import", index));
    } catch {
      duplicateFlags = records.map(() => false);
    }
  }

  async function doImport() {
    importing = true;
    importResult = null;
    try {
      const backend = getBackend();
      const result = await importRecords(backend, previewRecords, "ofx-import");

      // Store account metadata from file header if available
      if (fileHeader?.accountMetadata && mainAccount) {
        try {
          const accounts = await backend.listAccounts();
          const acct = accounts.find((a) => a.full_name === mainAccount);
          if (acct) {
            await backend.setAccountMetadata(acct.id, fileHeader.accountMetadata);
          }
        } catch {
          // Account metadata is non-critical
        }
      }

      // Create balance assertion from file header if available
      if (fileHeader?.balanceDate && fileHeader?.balanceAmount && fileHeader?.balanceCurrency) {
        try {
          const accounts = await backend.listAccounts();
          const acct = accounts.find((a) => a.full_name === mainAccount);
          if (acct) {
            await backend.createBalanceAssertion({
              id: uuidv7(),
              account_id: acct.id,
              date: fileHeader.balanceDate,
              currency: fileHeader.balanceCurrency,
              expected_balance: fileHeader.balanceAmount,
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

      importResult = result;
      const skipMsg = result.duplicates_skipped > 0 ? `, ${result.duplicates_skipped} duplicates skipped` : "";
      toast.success(`Imported ${result.entries_created} entries${skipMsg}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      importing = false;
    }
  }

  let dragIdx = $state<number | null>(null);
  let dropIdx = $state<number | null>(null);

  function moveRule(from: number, to: number) {
    if (from === to) return;
    const updated = [...rules];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    rules = updated;
    saveRules();
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
    parseResult = null;
    selectedStatement = null;
    mainAccount = ASSETS_BANK_IMPORT;
    fileHeader = null;
    previewRecords = [];
    previewWarnings = [];
    duplicateFlags = [];
    importResult = null;
    mlSuggestions = new Map();
    mlAccepted = new Set();
    mlClassifying = false;
    accountPaths = [];
  }

  // Reset on close
  $effect(() => {
    if (!open) resetDialog();
  });

  // Auto-advance when opened with initial content (drag-and-drop)
  $effect(() => {
    if (open && initialContent) {
      rawContent = initialContent;
      fileName = initialFileName;
      untrack(() => handleParse());
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>
        {#if step === 1}
          OFX Import — Upload & Configure
        {:else}
          OFX Import — Preview & Import
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {#if step === 1}
          Upload an OFX/QFX/QBO file or paste content directly.
        {:else}
          Review entries before importing.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <!-- Step 1: Upload & Configure -->
    {#if step === 1}
      <div class="space-y-4">
        <div class="flex items-center gap-4">
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            <Upload class="h-4 w-4" />
            <span>{fileName || "Choose file"}</span>
            <input type="file" accept=".ofx,.qfx,.qbo" class="hidden" onchange={handleFileChange} />
          </label>
        </div>

        {#if !parseResult}
          <textarea
            class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Or paste OFX content here..."
            bind:value={rawContent}
          ></textarea>
          <div class="flex justify-end">
            <Button onclick={handleParse} disabled={!rawContent.trim()}>
              <FileText class="mr-2 h-4 w-4" /> Parse
            </Button>
          </div>
        {/if}

        {#if parseResult && selectedStatement}
          <!-- Account info card -->
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Statement Info</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {#if selectedStatement.account.acctId}
                <div>
                  <span class="text-xs text-muted-foreground">Account #</span>
                  <p class="font-mono text-xs">{selectedStatement.account.acctId}</p>
                </div>
              {/if}
              <div>
                <span class="text-xs text-muted-foreground">Type</span>
                <p class="font-mono text-xs">{selectedStatement.account.accountType === "creditcard" ? "Credit Card" : selectedStatement.account.acctType ?? "Bank"}</p>
              </div>
              <div>
                <span class="text-xs text-muted-foreground">Currency</span>
                <p class="font-mono text-xs">{selectedStatement.currency}</p>
              </div>
              <div>
                <span class="text-xs text-muted-foreground">Transactions</span>
                <p class="font-mono text-xs">{txCount}</p>
              </div>
              {#if dateRange}
                <div>
                  <span class="text-xs text-muted-foreground">Date Range</span>
                  <p class="font-mono text-xs">{dateRange.from} &mdash; {dateRange.to}</p>
                </div>
              {/if}
              {#if selectedStatement.ledgerBalance}
                <div>
                  <span class="text-xs text-muted-foreground">Balance</span>
                  <p class="font-mono text-xs">{selectedStatement.ledgerBalance.balAmt} {selectedStatement.currency}</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- Statement selector (if multiple) -->
          {#if parseResult.statements.length > 1}
            <div class="flex flex-wrap gap-1.5">
              {#each parseResult.statements as stmt, idx}
                <Button
                  size="sm"
                  variant={selectedStatement === stmt ? "default" : "outline"}
                  class="text-xs h-7"
                  onclick={() => {
                    selectedStatement = stmt;
                    mainAccount = suggestMainAccount(stmt);
                  }}
                >
                  {stmt.account.accountType === "creditcard" ? "Credit Card" : "Bank"}
                  {stmt.account.acctId ? `...${stmt.account.acctId.slice(-4)}` : `#${idx + 1}`}
                  ({stmt.transactions.length} tx)
                </Button>
              {/each}
            </div>
          {/if}

          <!-- Main Account -->
          <div class="space-y-1">
            <label for="ofx-mainAcct" class="text-sm font-medium">Main Account</label>
            <Input id="ofx-mainAcct" bind:value={mainAccount} placeholder="Assets:Bank:Checking" />
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
                <div class="space-y-0 max-h-40 overflow-y-auto">
                  {#each rules as rule, index}
                    <div
                      role="listitem"
                      class="flex items-center gap-2 text-sm py-1 {dragIdx === index ? 'opacity-50' : ''}"
                      style={dropIdx === index ? "border-top: 2px solid hsl(var(--primary))" : ""}
                      draggable="true"
                      ondragstart={(e) => {
                        dragIdx = index;
                        if (e.dataTransfer) {
                          e.dataTransfer.effectAllowed = "move";
                        }
                      }}
                      ondragover={(e) => {
                        e.preventDefault();
                        dropIdx = index;
                      }}
                      ondragleave={() => {
                        if (dropIdx === index) dropIdx = null;
                      }}
                      ondrop={(e) => {
                        e.preventDefault();
                        if (dragIdx !== null) moveRule(dragIdx, index);
                        dragIdx = null;
                        dropIdx = null;
                      }}
                      ondragend={() => {
                        dragIdx = null;
                        dropIdx = null;
                      }}
                    >
                      <GripVertical class="h-3 w-3 text-muted-foreground cursor-grab shrink-0" />
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

          <!-- Parse warnings -->
          {#if parseResult.warnings.length > 0}
            <div class="text-xs text-muted-foreground space-y-0.5">
              {#each parseResult.warnings as w}
                <p>{w}</p>
              {/each}
            </div>
          {/if}

          <div class="flex justify-end">
            <Button onclick={generatePreview} disabled={txCount === 0}>
              Preview &rarr;
            </Button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Step 2: Preview & Import -->
    {#if step === 2}
      <div class="space-y-4">
        {#if importResult}
          <!-- Import Results -->
          <div class="rounded-md border bg-muted/50 p-4 space-y-3">
            <h4 class="text-sm font-semibold">Import Complete</h4>
            <div class="grid grid-cols-4 gap-4">
              <div class="text-center">
                <p class="text-2xl font-bold">{importResult.entries_created}</p>
                <p class="text-xs text-muted-foreground">Entries</p>
              </div>
              <div class="text-center">
                <p class="text-2xl font-bold">{importResult.duplicates_skipped}</p>
                <p class="text-xs text-muted-foreground">Duplicates Skipped</p>
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
            {#if importResult.balance_assertion_created}
              <p class="text-xs text-green-600 dark:text-green-400">Balance assertion created from OFX statement.</p>
            {/if}
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
                  class="h-7 text-xs"
                  onclick={runMlClassification}
                  disabled={mlClassifying || taskQueue.isActive("ml-classify")}
                >
                  <BrainCircuit class="h-3 w-3 mr-1" />
                  {mlClassifying ? "Classifying..." : "Classify with AI"}
                </Button>
              {/if}
            </div>
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
                {#each previewRecords.slice(0, 50) as rec, recIdx}
                  {@const sum = rec.lines.reduce((s, l) => s + parseFloat(l.amount), 0)}
                  {@const balanced = Math.abs(sum) < 0.0001}
                  {@const dup = duplicateFlags[recIdx] ?? false}
                  {@const mlSuggestion = mlSuggestions.get(recIdx)}
                  {@const mlIsAccepted = mlAccepted.has(recIdx)}
                  <Table.Row class={dup ? "opacity-40" : ""}>
                    <Table.Cell class="font-mono text-xs">{rec.date}</Table.Cell>
                    <Table.Cell class="text-xs max-w-[200px] truncate">
                      {rec.description}
                      {#if dup}<Badge variant="outline" class="ml-1 text-xs">dup</Badge>{/if}
                    </Table.Cell>
                    <Table.Cell class="text-xs">
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
            <Button variant="outline" onclick={() => { step = 1; }}>Back</Button>
            <Button onclick={doImport} disabled={importing || nonDuplicateCount === 0}>
              {importing ? "Importing..." : `Import ${nonDuplicateCount} entries`}
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
