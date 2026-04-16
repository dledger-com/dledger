<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { importDrop } from "$lib/data/import-drop.svelte.js";
  import { toast } from "svelte-sonner";
  import { readFileAsText } from "$lib/utils/read-file-text.js";
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
    parseQif,
    parseQifDate,
    convertQifToRecords,
    suggestQifMainAccount,
    detectQifDateFormat,
    isTransfer,
    type QifSection,
    type QifParseResult,
    type QifDateFormat,
  } from "$lib/qif/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import { TransactionClassifier, type ClassificationResult } from "$lib/ml/classifier.js";
  import { classifyTransactions } from "$lib/csv-presets/categorize.js";
  import { ASSETS_BANK_IMPORT } from "$lib/accounts/paths.js";
  import * as m from "$paraglide/messages.js";
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

  // -- Wizard state --
  let step = $state<1 | 2>(1);

  // -- Step 1 state --
  let rawContent = $state("");
  let fileName = $state("");

  // -- Parsed QIF data --
  let parseResult = $state<QifParseResult | null>(null);
  let selectedSection = $state<QifSection | null>(null);
  let mainAccount = $state(ASSETS_BANK_IMPORT);

  // -- QIF-specific options --
  let dateFormatOverride = $state<"auto" | QifDateFormat>("auto");
  let detectedDateFormat = $state<QifDateFormat>("MM/DD/YY");
  let europeanNumbers = $state(false);
  let transferMapping = $state<Map<string, string>>(new Map());

  let effectiveDateFormat = $derived<QifDateFormat>(
    dateFormatOverride === "auto" ? detectedDateFormat : dateFormatOverride,
  );

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
  let unmappedAccounts = $state<string[]>([]);

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
          return { summary: m.import_ml_classified_summary({ classified: suggestions.size, total: previewRecords.length }) };
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
  let txCount = $derived(selectedSection?.transactions.length ?? 0);
  let dateRange = $derived.by(() => {
    if (!selectedSection || selectedSection.transactions.length === 0) return null;
    const dates = selectedSection.transactions
      .map((tx) => parseQifDate(tx.date, effectiveDateFormat))
      .filter((d): d is string => d !== null)
      .sort();
    if (dates.length === 0) return null;
    return { from: dates[0], to: dates[dates.length - 1] };
  });

  // Load rules from settings
  $effect(() => {
    rules = settings.settings.csvCategorizationRules ?? [];
  });

  function saveRules() {
    settings.update({ csvCategorizationRules: rules });
  }

  function sectionLabel(section: QifSection): string {
    const name = section.account?.name;
    switch (section.type) {
      case "CCard": return name ?? m.qif_section_ccard();
      case "Cash": return name ?? m.qif_section_cash();
      case "Oth A": return name ?? m.qif_section_oth_a();
      case "Oth L": return name ?? m.qif_section_oth_l();
      default: return name ?? m.qif_section_bank();
    }
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
      toast.error(m.error_provide_qif_content());
      return;
    }

    parseResult = parseQif(rawContent);

    if (parseResult.sections.length === 0) {
      toast.error(parseResult.warnings[0] ?? m.error_provide_qif_content());
      return;
    }

    // Auto-select first section
    selectedSection = parseResult.sections[0];
    mainAccount = suggestQifMainAccount(selectedSection);

    // Auto-detect date format from all transactions across sections
    const allTx = parseResult.sections.flatMap((s) => s.transactions);
    detectedDateFormat = detectQifDateFormat(allTx);

    // Scan for transfer accounts to pre-populate mapping UI
    scanTransferAccounts(selectedSection);
  }

  function scanTransferAccounts(section: QifSection) {
    const names = new Set<string>();
    for (const tx of section.transactions) {
      if (tx.category) {
        const t = isTransfer(tx.category);
        if (t.isTransfer) names.add(t.accountName);
      }
      for (const split of tx.splits) {
        const t = isTransfer(split.category);
        if (t.isTransfer) names.add(t.accountName);
      }
    }
    unmappedAccounts = [...names];
    for (const name of names) {
      if (!transferMapping.has(name)) {
        transferMapping.set(name, `Assets:Bank:${name}`);
      }
    }
    transferMapping = new Map(transferMapping);
  }

  async function generatePreview(autoSkipOnly = false) {
    if (!selectedSection) return;

    const result = convertQifToRecords(selectedSection, {
      mainAccount,
      rules,
      dateFormat: effectiveDateFormat,
      europeanNumbers,
      accountMapping: transferMapping,
    });

    previewRecords = result.records;
    previewWarnings = result.warnings;
    fileHeader = result.fileHeader;
    unmappedAccounts = result.unmappedAccounts;

    // If there are new unmapped accounts, update the mapping with defaults
    for (const name of result.unmappedAccounts) {
      if (!transferMapping.has(name)) {
        transferMapping.set(name, `Assets:Bank:${name}`);
      }
    }
    transferMapping = new Map(transferMapping);

    await detectDuplicates(result.records);

    const nonDupCount = result.records.length - duplicateFlags.filter(Boolean).length;
    if (nonDupCount === 0) {
      if (importDrop.batchActive) {
        toast.info(
          result.records.length === 0
            ? m.toast_skipped_no_entries({ name: fileName })
            : m.toast_skipped_all_duplicates({ name: fileName, count: result.records.length }),
        );
        importDrop.skipFile();
      } else {
        open = false;
        toast.info(
          result.records.length === 0
            ? m.toast_no_entries_found({ name: fileName })
            : m.toast_all_duplicates({ name: fileName, count: result.records.length }),
        );
      }
      return;
    }

    if (autoSkipOnly) return;
    fetchAccountPaths();
    step = 2;
  }

  async function detectDuplicates(records: CsvRecord[]) {
    try {
      const backend = getBackend();
      const index = await buildDedupIndex(backend, records, "qif-import");
      duplicateFlags = markDuplicates(records, "qif-import", index);
    } catch {
      duplicateFlags = records.map(() => false);
    }
  }

  function doImport() {
    const recordsSnapshot = [...previewRecords];
    if (importTags.length > 0) {
      for (const rec of recordsSnapshot) {
        const existing = parseTags(rec.metadata?.[TAGS_META_KEY]);
        const merged = [...new Set([...existing, ...importTags])];
        rec.metadata = { ...rec.metadata, [TAGS_META_KEY]: serializeTags(merged) };
      }
    }
    applyRuleTags(recordsSnapshot, rules);

    const taskId = enqueueRecordImport({
      key: "qif-import",
      label: m.qif_task_label(),
      records: recordsSnapshot,
      presetId: "qif-import",
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
    rawContent = "";
    fileName = "";
    parseResult = null;
    selectedSection = null;
    mainAccount = ASSETS_BANK_IMPORT;
    dateFormatOverride = "auto";
    detectedDateFormat = "MM/DD/YY";
    europeanNumbers = false;
    transferMapping = new Map();
    fileHeader = null;
    previewRecords = [];
    previewWarnings = [];
    duplicateFlags = [];
    unmappedAccounts = [];
    mlSuggestions = new Map();
    mlAccepted = new Set();
    mlClassifying = false;
    accountPaths = [];
    importTags = [];
  }

  $effect.pre(() => {
    if (open && initialContent) {
      untrack(() => resetDialog());
      rawContent = initialContent;
      fileName = initialFileName;
      untrack(() => handleParse());
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
          {m.qif_title_upload()}
        {:else}
          {m.qif_title_preview()}
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {#if step === 1}
          {m.qif_desc_upload()}
        {:else}
          {m.qif_desc_preview()}
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
            <span>{fileName || m.qif_choose_file()}</span>
            <input type="file" accept=".qif" class="hidden" onchange={handleFileChange} />
          </label>
        </div>

        {#if !parseResult}
          <textarea
            class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={m.qif_paste_placeholder()}
            bind:value={rawContent}
          ></textarea>
          <div class="flex justify-end">
            <Button onclick={handleParse} disabled={!rawContent.trim()}>
              <FileText class="mr-2 h-4 w-4" /> {m.btn_parse()}
            </Button>
          </div>
        {/if}

        {#if parseResult && selectedSection}
          <!-- Section info card -->
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{m.import_statement_info()}</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {#if selectedSection.account?.name}
                <div>
                  <span class="text-xs text-muted-foreground">{m.label_name()}</span>
                  <p class="font-mono text-xs">{selectedSection.account.name}</p>
                </div>
              {/if}
              <div>
                <span class="text-xs text-muted-foreground">{m.label_type()}</span>
                <p class="font-mono text-xs">{sectionLabel(selectedSection)}</p>
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
            </div>
          </div>

          <!-- Section selector (if multiple) -->
          {#if parseResult.sections.length > 1}
            <div class="flex flex-wrap gap-1.5">
              {#each parseResult.sections as sect, idx}
                <Button
                  size="sm"
                  variant={selectedSection === sect ? "default" : "outline"}
                  class="text-xs h-7"
                  onclick={() => {
                    selectedSection = sect;
                    mainAccount = suggestQifMainAccount(sect);
                    scanTransferAccounts(sect);
                  }}
                >
                  {sectionLabel(sect)}
                  ({m.label_tx_count({ count: sect.transactions.length })})
                </Button>
              {/each}
            </div>
          {/if}

          <!-- Main Account -->
          <div class="space-y-1">
            <label for="qif-mainAcct" class="text-sm font-medium">{m.label_main_account()}</label>
            <Input id="qif-mainAcct" bind:value={mainAccount} placeholder={m.placeholder_bank_account()} />
          </div>

          <!-- Date Format Selector -->
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-sm font-medium">{m.qif_date_format()}</label>
              <Select.Root type="single" value={dateFormatOverride} onValueChange={(v) => { dateFormatOverride = v as "auto" | QifDateFormat; }}>
                <Select.Trigger class="text-xs">
                  {#if dateFormatOverride === "auto"}
                    {m.qif_date_format_auto({ detected: detectedDateFormat })}
                  {:else if dateFormatOverride === "MM/DD/YY"}
                    {m.qif_date_format_us()}
                  {:else if dateFormatOverride === "DD/MM/YY"}
                    {m.qif_date_format_eu()}
                  {:else}
                    {m.qif_date_format_eu_dot()}
                  {/if}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="auto">{m.qif_date_format_auto({ detected: detectedDateFormat })}</Select.Item>
                  <Select.Item value="MM/DD/YY">{m.qif_date_format_us()}</Select.Item>
                  <Select.Item value="DD/MM/YY">{m.qif_date_format_eu()}</Select.Item>
                  <Select.Item value="DD.MM.YY">{m.qif_date_format_eu_dot()}</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>
            <div class="flex items-end gap-2 pb-1">
              <Checkbox id="qif-european" bind:checked={europeanNumbers} />
              <label for="qif-european" class="text-sm">{m.qif_european_numbers()}</label>
            </div>
          </div>

          <!-- Transfer Account Mapping -->
          {#if unmappedAccounts.length > 0}
            <div class="space-y-2">
              <h4 class="text-sm font-medium">{m.qif_transfer_mapping()}</h4>
              <p class="text-xs text-muted-foreground">{m.qif_unmapped_transfers()}</p>
              <div class="space-y-1">
                {#each unmappedAccounts as name}
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-mono w-40 truncate" title={name}>[{name}]</span>
                    <span class="text-muted-foreground">&rarr;</span>
                    <Input
                      class="text-xs h-8 flex-1"
                      value={transferMapping.get(name) ?? ""}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value;
                        transferMapping.set(name, v);
                        transferMapping = new Map(transferMapping);
                      }}
                    />
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Categorization Rules -->
          <CategorizationRulesEditor
            {rules}
            onchange={(updated) => { rules = updated; saveRules(); }}
          />

          <!-- Parse warnings -->
          {#if parseResult.warnings.length > 0}
            <div class="text-xs text-muted-foreground space-y-0.5">
              {#each parseResult.warnings as w}
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
          <div class="flex items-center justify-between">
            <p class="text-sm">
              {m.import_entries_to_import({ count: nonDuplicateCount })}
              {#if duplicateCount > 0}
                <Badge variant="secondary" class="ml-2">{m.import_duplicates_will_skip({ count: duplicateCount })}</Badge>
              {/if}
              {#if previewWarnings.length > 0}
                <Badge variant="destructive" class="ml-2">{m.import_warnings_count({ count: previewWarnings.length })}</Badge>
              {/if}
            </p>
            <div class="flex items-center gap-2">
              {#if mlSuggestions.size > 0}
                <Badge variant="outline" class="text-xs">{m.import_ml_suggestions_count({ count: mlSuggestions.size })}</Badge>
                <Button size="sm" variant="default" class="h-7 text-xs" onclick={applyMlSuggestions}>
                  {m.import_accept_suggestions({ count: mlAccepted.size })}
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
                        <span class="text-muted-foreground text-xs">{m.import_more_lines({ count: rec.lines.length - 4 })}</span>
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
                      {m.import_more_entries({ count: previewRecords.length - 50 })}
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
              <Button onclick={doImport} disabled={taskQueue.isActive("qif-import")}>
                {taskQueue.isActive("qif-import") ? m.state_importing() : m.import_n_entries({ count: nonDuplicateCount })}
              </Button>
            {/if}
          </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
