<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { importDrop } from "$lib/data/import-drop.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
  import {
    enqueueRecordImport,
    buildDedupIndex,
    markDuplicates,
    applyRuleTags,
    type CsvRecord,
    type CsvFileHeader,
    type DedupIndex,
  } from "$lib/csv-presets/index.js";
  import {
    extractPdfPages,
    parseLbpStatement,
    parseN26Statement,
    parseNuriStatement,
    parseDeblockStatement,
    convertPdfToRecords,
    suggestMainAccount,
    type PdfStatement,
  } from "$lib/pdf/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { TransactionClassifier, type ClassificationResult } from "$lib/ml/classifier.js";
  import { classifyTransactions } from "$lib/csv-presets/categorize.js";
  import { ASSETS_BANK_IMPORT } from "$lib/accounts/paths.js";
  import AccountCombobox from "./AccountCombobox.svelte";
  import TagInput from "./TagInput.svelte";
  import CategorizationRulesEditor from "./CategorizationRulesEditor.svelte";
  import * as m from "$paraglide/messages.js";
  import { serializeTags, parseTags, TAGS_META_KEY, tagColor } from "$lib/utils/tags.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Check from "lucide-svelte/icons/check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import BrainCircuit from "lucide-svelte/icons/brain-circuit";
  import Loader from "lucide-svelte/icons/loader";

  let {
    open = $bindable(false),
    initialFile = null as File | null,
    initialFileName = "",
  }: {
    open: boolean;
    initialFile?: File | null;
    initialFileName?: string;
  } = $props();

  const settings = new SettingsStore();

  // -- Wizard state --
  let step = $state<1 | 2>(1);

  // -- Step 1 state --
  let fileName = $state("");
  let parsing = $state(false);

  // -- Parsed PDF data --
  let statement = $state<PdfStatement | null>(null);
  let detectedBank = $state<"lbp" | "n26" | "nuri" | "deblock" | null>(null);
  let mainAccount = $state(ASSETS_BANK_IMPORT);

  // -- Categorization rules --
  let rules = $state<CsvCategorizationRule[]>([]);

  // -- Batch tags for import --
  let importTags = $state<string[]>([]);

  // -- Step 2 state --
  let previewRecords = $state<CsvRecord[]>([]);
  let previewWarnings = $state<string[]>([]);
  let fileHeader = $state<CsvFileHeader | null>(null);
  let duplicateFlags = $state<boolean[]>([]);
  let duplicateCount = $derived(duplicateFlags.filter(Boolean).length);
  let nonDuplicateCount = $derived(previewRecords.length - duplicateCount);

  // -- ML classification state --
  let mlSuggestions = $state<Map<number, ClassificationResult>>(new Map());
  let mlAccepted = $state<Set<number>>(new Set());
  let mlClassifying = $state(false);
  let mlEnabled = $derived(settings.settings.mlClassificationEnabled ?? true);
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
      label: m.state_classifying_transactions(),
      description: m.ml_description(),
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
            backend,
          );
          mlSuggestions = suggestions;
          mlAccepted = new Set(suggestions.keys());
          return { summary: m.import_ml_classified_summary({ classified: String(suggestions.size), total: String(previewRecords.length) }) };
        } finally {
          classifier.dispose();
          mlClassifying = false;
        }
      },
    });

    if (!taskId) {
      mlClassifying = false;
      toast.error(m.error_ml_already_running());
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
    toast.success(m.toast_ml_applied());
  }

  // -- Derived info --
  let txCount = $derived(statement?.transactions.length ?? 0);
  let dateRange = $derived.by(() => {
    if (!statement || statement.transactions.length === 0) return null;
    const dates = statement.transactions.map((tx) => tx.date).sort();
    return { from: dates[0], to: dates[dates.length - 1] };
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
    await parseFile(file);
  }

  async function parseFile(file: File) {
    fileName = file.name;
    parsing = true;
    try {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const pages = await extractPdfPages(data);

      // Auto-detect bank by trying all parsers
      const n26Result = parseN26Statement(pages);
      const lbpResult = parseLbpStatement(pages);
      const nuriResult = parseNuriStatement(pages);
      const deblockResult = parseDeblockStatement(pages);

      // Pick the parser that produces the most transactions
      const candidates: { result: PdfStatement; bank: "n26" | "lbp" | "nuri" | "deblock" }[] = [
        { result: n26Result, bank: "n26" },
        { result: lbpResult, bank: "lbp" },
        { result: nuriResult, bank: "nuri" },
        { result: deblockResult, bank: "deblock" },
      ];
      const best = candidates
        .filter((c) => c.result.transactions.length > 0)
        .sort((a, b) => b.result.transactions.length - a.result.transactions.length)[0];

      if (best) {
        statement = best.result;
        detectedBank = best.bank;
      } else {
        // All failed — show the one with fewest warnings
        const fallback = candidates.sort((a, b) => a.result.warnings.length - b.result.warnings.length)[0];
        statement = fallback.result;
        detectedBank = null;
        toast.error(statement.warnings[0] ?? m.error_no_transactions_pdf());
        return;
      }

      mainAccount = suggestMainAccount(statement, detectedBank);
    } catch (err) {
      toast.error(m.toast_pdf_parse_failed({ message: err instanceof Error ? err.message : String(err) }));
    } finally {
      parsing = false;
    }
  }

  async function generatePreview(autoSkipOnly = false) {
    if (!statement) return;

    const result = convertPdfToRecords(statement, {
      mainAccount,
      rules,
    });

    previewRecords = result.records;
    previewWarnings = result.warnings;
    fileHeader = result.fileHeader;

    await detectDuplicates(result.records);

    const nonDupCount = result.records.length - duplicateFlags.filter(Boolean).length;
    if (nonDupCount === 0) {
      if (importDrop.batchActive) {
        toast.info(
          result.records.length === 0
            ? m.toast_skipped_no_entries({ name: fileName })
            : m.toast_skipped_all_duplicates({ name: fileName, count: String(result.records.length) }),
        );
        importDrop.skipFile();
      } else {
        open = false;
        toast.info(
          result.records.length === 0
            ? m.toast_no_entries_found({ name: fileName })
            : m.toast_all_duplicates({ name: fileName, count: String(result.records.length) }),
        );
      }
      return;
    }

    if (autoSkipOnly) return;
    fetchAccountPaths();
    step = 2;
  }

  let presetId = $derived(detectedBank === "n26" ? "pdf-n26" : detectedBank === "nuri" ? "pdf-nuri" : detectedBank === "deblock" ? "pdf-deblock" : "pdf-lbp");

  async function detectDuplicates(records: CsvRecord[]) {
    try {
      const backend = getBackend();
      const index = await buildDedupIndex(backend, records, presetId);
      duplicateFlags = markDuplicates(records, presetId, index);
    } catch {
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

    const presetIdSnapshot = presetId;
    const fileHeaderSnapshot = fileHeader;
    const mainAccountSnapshot = mainAccount;

    const taskId = enqueueRecordImport({
      key: "pdf-import",
      label: m.import_pdf_task_label(),
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
      toast.error(m.error_import_in_progress());
    }
  }

  function resetDialog() {
    step = 1;
    fileName = "";
    parsing = false;
    statement = null;
    detectedBank = null;
    mainAccount = ASSETS_BANK_IMPORT;
    fileHeader = null;
    previewRecords = [];
    previewWarnings = [];
    duplicateFlags = [];
    mlSuggestions = new Map();
    mlAccepted = new Set();
    mlClassifying = false;
    accountPaths = [];
    importTags = [];
  }

  // Auto-advance when opened with initial file (drag-and-drop),
  // or reset state on manual open. No reset on close to avoid flash.
  $effect.pre(() => {
    if (open && initialFile) {
      const file = initialFile;
      untrack(() => {
        resetDialog();
        parseFile(file).then(() => {
          if (importDrop.batchActive) {
            generatePreview(true);
          }
        });
      });
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
          {m.dialog_pdf_upload_configure()}
        {:else}
          {m.dialog_pdf_preview_import()}
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {#if step === 1}
          {m.dialog_pdf_upload_desc()}{#if detectedBank === "n26"} {m.dialog_pdf_detected({ bank: "N26" })}{:else if detectedBank === "lbp"} {m.dialog_pdf_detected({ bank: "La Banque Postale" })}{:else if detectedBank === "nuri"} {m.dialog_pdf_detected({ bank: "Nuri/Bitwala" })}{:else if detectedBank === "deblock"} {m.dialog_pdf_detected({ bank: "Deblock" })}{/if}
        {:else}
          {m.dialog_pdf_review_desc()}
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
            <span>{parsing ? m.state_parsing() : fileName || m.label_choose_pdf()}</span>
            <input type="file" accept=".pdf" class="hidden" onchange={handleFileChange} />
          </label>
        </div>

        {#if statement}
          <!-- Statement info card -->
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{m.import_statement_info()}</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {#if statement.accountNumber}
                <div>
                  <span class="text-xs text-muted-foreground">{m.import_account_number()}</span>
                  <p class="font-mono text-xs">{statement.accountNumber}</p>
                </div>
              {/if}
              {#if statement.iban}
                <div>
                  <span class="text-xs text-muted-foreground">{m.label_iban()}</span>
                  <p class="font-mono text-xs">{statement.iban}</p>
                </div>
              {/if}
              <div>
                <span class="text-xs text-muted-foreground">{m.label_currency()}</span>
                <p class="font-mono text-xs">{statement.currency}</p>
              </div>
              <div>
                <span class="text-xs text-muted-foreground">{m.label_transactions()}</span>
                <p class="font-mono text-xs">{txCount}</p>
              </div>
              {#if dateRange}
                <div>
                  <span class="text-xs text-muted-foreground">{m.label_date_range()}</span>
                  <p class="font-mono text-xs">{dateRange.from} &mdash; {dateRange.to}</p>
                </div>
              {/if}
              {#if statement.openingBalance !== null}
                <div>
                  <span class="text-xs text-muted-foreground">{m.label_opening_balance()}</span>
                  <p class="font-mono text-xs">{statement.openingBalance} {statement.currency}</p>
                </div>
              {/if}
              {#if statement.closingBalance !== null}
                <div>
                  <span class="text-xs text-muted-foreground">{m.label_closing_balance()}</span>
                  <p class="font-mono text-xs">{statement.closingBalance} {statement.currency}</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- Main Account -->
          <div class="space-y-1">
            <label for="pdf-mainAcct" class="text-sm font-medium">{m.label_main_account()}</label>
            <Input id="pdf-mainAcct" bind:value={mainAccount} placeholder={m.placeholder_bank_account()} />
          </div>

          <!-- Categorization Rules -->
          <CategorizationRulesEditor
            {rules}
            onchange={(updated) => { rules = updated; saveRules(); }}
          />

          <!-- Parse warnings -->
          {#if statement.warnings.length > 0}
            <div class="text-xs text-muted-foreground space-y-0.5">
              {#each statement.warnings as w}
                <p>{w}</p>
              {/each}
            </div>
          {/if}

          <div class="flex justify-end">
            <Button onclick={() => generatePreview()} disabled={txCount === 0}>
              {m.import_preview_arrow()} &rarr;
            </Button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Step 2: Preview & Import -->
    {#if step === 2}
      <div class="space-y-4">
          <!-- Preview -->
          <div class="flex items-center justify-between">
            <p class="text-sm">
              {m.import_entries_to_import({ count: String(nonDuplicateCount) })}
              {#if duplicateCount > 0}
                <Badge variant="secondary" class="ml-2">{m.import_duplicates_will_skip({ count: String(duplicateCount) })}</Badge>
              {/if}
              {#if previewWarnings.length > 0}
                <Badge variant="destructive" class="ml-2">{m.import_warnings_count({ count: String(previewWarnings.length) })}</Badge>
              {/if}
            </p>
            <div class="flex items-center gap-2">
              {#if mlSuggestions.size > 0}
                <Badge variant="outline" class="text-xs">{m.import_ml_suggestions_count({ count: String(mlSuggestions.size) })}</Badge>
                <Button size="sm" variant="default" class="h-7 text-xs" onclick={applyMlSuggestions}>
                  {m.import_accept_suggestions({ count: String(mlAccepted.size) })}
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
                  {mlClassifying ? m.state_classifying() : m.btn_classify_with_ai()}
                </Button>
              {/if}
            </div>
          </div>

          <!-- Batch tags for all imported entries -->
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground shrink-0">{m.import_tags_for_all()}</span>
            <TagInput tags={importTags} onchange={(t) => { importTags = t; }} class="flex-1" />
          </div>

          {#if previewWarnings.length > 0}
            <details>
              <summary class="text-xs text-muted-foreground cursor-pointer">{m.btn_show_warnings()}</summary>
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
                  <Table.Head class="w-24">{m.label_date()}</Table.Head>
                  <Table.Head>{m.label_description()}</Table.Head>
                  <Table.Head class="min-w-[260px]">{m.label_line_items()}</Table.Head>
                  <Table.Head class="w-16 text-center">{m.label_balance()}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each previewRecords.slice(0, 50) as rec, recIdx}
                  {@const sum = rec.lines.reduce((s, l) => s + parseFloat(l.amount), 0)}
                  {@const balanced = Math.abs(sum) < 0.0001}
                  {@const dup = duplicateFlags[recIdx] ?? false}
                  {@const mlSuggestion = mlSuggestions.get(recIdx)}
                  {@const mlIsAccepted = mlAccepted.has(recIdx)}
                  {@const recTags = parseTags(rec.metadata?.[TAGS_META_KEY])}
                  <Table.Row class={dup ? "opacity-40" : ""}>
                    <Table.Cell class="font-mono text-xs">{rec.date}</Table.Cell>
                    <Table.Cell class="text-xs max-w-[250px] whitespace-normal">
                      <span>{rec.description}</span>
                      {#if rec.metadata?.["bank-category"]}<span class="text-muted-foreground ml-1">• {rec.metadata["bank-category"]}</span>{/if}
                      {#if rec.metadata?.["transaction-type"]}<Badge variant="secondary" class="ml-1 text-[10px] px-1 py-0 h-4">{rec.metadata["transaction-type"]}</Badge>{/if}
                      {#if dup}<Badge variant="outline" class="ml-1 text-xs">{m.import_dup_badge()}</Badge>{/if}
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
                          <span class={parseFloat(line.amount) >= 0 ? "text-positive" : "text-negative"}>
                            {parseFloat(line.amount) >= 0 ? "+" : ""}{line.amount} {line.currency}
                          </span>
                        </div>
                      {/each}
                      {#if rec.lines.length > 4}
                        <span class="text-muted-foreground text-xs">{m.import_more_lines({ count: String(rec.lines.length - 4) })}</span>
                      {/if}
                      {#if mlSuggestion}
                        <button
                          class="flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded text-xs cursor-pointer {mlIsAccepted ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-muted text-muted-foreground line-through'}"
                          onclick={() => toggleMlAccept(recIdx)}
                          title={mlIsAccepted ? m.ml_click_to_reject() : m.ml_click_to_accept()}
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
                      {m.import_more_entries({ count: String(previewRecords.length - 50) })}
                    </Table.Cell>
                  </Table.Row>
                {/if}
              </Table.Body>
            </Table.Root>
          </div>

          <div class="flex justify-between">
            <Button variant="outline" onclick={() => { step = 1; }}>{m.btn_back()}</Button>
            {#if nonDuplicateCount === 0}
              {#if importDrop.batchActive}
                <Button variant="outline" onclick={() => importDrop.skipFile()}>{m.btn_skip()}</Button>
              {:else}
                <Button variant="outline" onclick={() => { open = false; }}>{m.btn_cancel()}</Button>
              {/if}
            {:else}
              <Button onclick={doImport} disabled={taskQueue.isActive("pdf-import")}>
                {taskQueue.isActive("pdf-import") ? m.state_importing() : m.import_n_entries({ count: String(nonDuplicateCount) })}
              </Button>
            {/if}
          </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
