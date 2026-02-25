<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
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
    extractPdfPages,
    parseLbpStatement,
    parseN26Statement,
    parseNuriStatement,
    parseDeblockStatement,
    convertPdfToRecords,
    suggestMainAccount,
    type PdfStatement,
  } from "$lib/pdf/index.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import GripVertical from "lucide-svelte/icons/grip-vertical";
  import Plus from "lucide-svelte/icons/plus";
  import Check from "lucide-svelte/icons/check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";

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
  let mainAccount = $state("Assets:Banks:Import");

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
        toast.error(statement.warnings[0] ?? "No transactions found in PDF");
        return;
      }

      mainAccount = suggestMainAccount(statement, detectedBank);
    } catch (err) {
      toast.error(`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      parsing = false;
    }
  }

  async function generatePreview() {
    if (!statement) return;

    const result = convertPdfToRecords(statement, {
      mainAccount,
      rules,
    });

    previewRecords = result.records;
    previewWarnings = result.warnings;
    fileHeader = result.fileHeader;

    await detectDuplicates(result.records);
    step = 2;
  }

  let presetId = $derived(detectedBank === "n26" ? "pdf-n26" : detectedBank === "nuri" ? "pdf-nuri" : detectedBank === "deblock" ? "pdf-deblock" : "pdf-lbp");

  async function detectDuplicates(records: CsvRecord[]) {
    try {
      const backend = getBackend();
      const index = await buildDedupIndex(backend, records, presetId);
      duplicateFlags = records.map((rec) => isDuplicate(rec, presetId, index));
    } catch {
      duplicateFlags = records.map(() => false);
    }
  }

  async function doImport() {
    importing = true;
    importResult = null;
    try {
      const backend = getBackend();
      const result = await importRecords(backend, previewRecords, presetId);

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
    fileName = "";
    parsing = false;
    statement = null;
    detectedBank = null;
    mainAccount = "Assets:Banks:Import";
    fileHeader = null;
    previewRecords = [];
    previewWarnings = [];
    duplicateFlags = [];
    importResult = null;
  }

  // Reset on close
  $effect(() => {
    if (!open) resetDialog();
  });

  // Auto-advance when opened with initial file (drag-and-drop)
  $effect(() => {
    if (open && initialFile) {
      const file = initialFile;
      untrack(() => parseFile(file));
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-fit max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>
        {#if step === 1}
          PDF Import — Upload & Configure
        {:else}
          PDF Import — Preview & Import
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {#if step === 1}
          Upload a PDF bank statement.{#if detectedBank === "n26"} Detected: N26.{:else if detectedBank === "lbp"} Detected: La Banque Postale.{:else if detectedBank === "nuri"} Detected: Nuri/Bitwala.{:else if detectedBank === "deblock"} Detected: Deblock.{/if}
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
            <span>{parsing ? "Parsing..." : fileName || "Choose PDF file"}</span>
            <input type="file" accept=".pdf" class="hidden" onchange={handleFileChange} />
          </label>
        </div>

        {#if statement}
          <!-- Statement info card -->
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Statement Info</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {#if statement.accountNumber}
                <div>
                  <span class="text-xs text-muted-foreground">Account #</span>
                  <p class="font-mono text-xs">{statement.accountNumber}</p>
                </div>
              {/if}
              {#if statement.iban}
                <div>
                  <span class="text-xs text-muted-foreground">IBAN</span>
                  <p class="font-mono text-xs">{statement.iban}</p>
                </div>
              {/if}
              <div>
                <span class="text-xs text-muted-foreground">Currency</span>
                <p class="font-mono text-xs">{statement.currency}</p>
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
              {#if statement.openingBalance !== null}
                <div>
                  <span class="text-xs text-muted-foreground">Opening Balance</span>
                  <p class="font-mono text-xs">{statement.openingBalance} {statement.currency}</p>
                </div>
              {/if}
              {#if statement.closingBalance !== null}
                <div>
                  <span class="text-xs text-muted-foreground">Closing Balance</span>
                  <p class="font-mono text-xs">{statement.closingBalance} {statement.currency}</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- Main Account -->
          <div class="space-y-1">
            <label for="pdf-mainAcct" class="text-sm font-medium">Main Account</label>
            <Input id="pdf-mainAcct" bind:value={mainAccount} placeholder="Assets:Banks:LaBanquePostale:0020" />
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
          {#if statement.warnings.length > 0}
            <div class="text-xs text-muted-foreground space-y-0.5">
              {#each statement.warnings as w}
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
              <p class="text-xs text-green-600 dark:text-green-400">Balance assertion created from PDF statement.</p>
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
                  <Table.Row class={dup ? "opacity-40" : ""}>
                    <Table.Cell class="font-mono text-xs">{rec.date}</Table.Cell>
                    <Table.Cell class="text-xs max-w-[200px] truncate">
                      {rec.description}
                      {#if dup}<Badge variant="outline" class="ml-1 text-xs">dup</Badge>{/if}
                    </Table.Cell>
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
