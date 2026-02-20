<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { parseCsv, importCsv, type CsvImportOptions, type CsvImportResult } from "$lib/utils/csv-import.js";
  import { toast } from "svelte-sonner";

  let rawContent = $state("");
  let delimiter = $state(",");
  let dateFormat = $state("YYYY-MM-DD");
  let importing = $state(false);
  let importResult = $state<CsvImportResult | null>(null);

  // Preview
  let previewHeaders = $state<string[]>([]);
  let previewRows = $state<string[][]>([]);

  // Column mappings
  let dateColumn = $state("");
  let descriptionColumn = $state("");
  let debitAccountColumn = $state("");
  let debitAmountColumn = $state("");
  let creditAccountColumn = $state("");
  let creditAmountColumn = $state("");
  let currencyColumn = $state("");

  function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      rawContent = reader.result as string;
      updatePreview();
    };
    reader.readAsText(file);
  }

  function updatePreview() {
    const { headers, rows } = parseCsv(rawContent, delimiter);
    previewHeaders = headers;
    previewRows = rows.slice(0, 10);

    // Auto-detect common column names
    if (!dateColumn) {
      const dateNames = ["date", "Date", "DATE", "Transaction Date", "transaction_date", "posting_date"];
      dateColumn = headers.find((h) => dateNames.includes(h.trim())) ?? "";
    }
    if (!descriptionColumn) {
      const descNames = ["description", "Description", "DESC", "memo", "Memo", "narrative", "Narrative", "payee", "Payee"];
      descriptionColumn = headers.find((h) => descNames.includes(h.trim())) ?? "";
    }
  }

  async function doImport() {
    if (!rawContent.trim() || !dateColumn) {
      toast.error("Please provide CSV content and select a date column");
      return;
    }

    const lines: CsvImportOptions["lines"] = [];

    // Build the mapping: debit line + credit line
    if (debitAccountColumn && debitAmountColumn) {
      lines.push({
        accountColumn: debitAccountColumn.startsWith("=") ? debitAccountColumn : debitAccountColumn,
        currencyColumn: currencyColumn || undefined,
        amountColumn: debitAmountColumn,
      });
    }
    if (creditAccountColumn && creditAmountColumn) {
      lines.push({
        accountColumn: creditAccountColumn.startsWith("=") ? creditAccountColumn : creditAccountColumn,
        currencyColumn: currencyColumn || undefined,
        amountColumn: creditAmountColumn,
        amountNegate: true,
      });
    }

    if (lines.length === 0) {
      toast.error("Please configure at least one line item mapping");
      return;
    }

    importing = true;
    importResult = null;
    try {
      importResult = await importCsv(getBackend(), rawContent, {
        delimiter,
        dateColumn,
        descriptionColumn: descriptionColumn || undefined,
        lines,
        dateFormat,
      });
      toast.success(`Imported ${importResult.entries_created} entries`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      importing = false;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">CSV Import</h1>
    <p class="text-muted-foreground">Import transactions from CSV files.</p>
  </div>

  <!-- File input + paste -->
  <Card.Root>
    <Card.Header>
      <Card.Title>CSV Data</Card.Title>
      <Card.Description>Upload a CSV file or paste content directly.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <Input type="file" accept=".csv,.tsv,.txt" onchange={handleFileChange} />
      <textarea
        id="csv-data"
        class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        placeholder="Or paste CSV content here..."
        bind:value={rawContent}
        oninput={updatePreview}
      ></textarea>
    </Card.Content>
  </Card.Root>

  <!-- Preview -->
  {#if previewHeaders.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>Preview</Card.Title>
        <Card.Description>First {previewRows.length} rows of {previewRows.length}+ total</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                {#each previewHeaders as header}
                  <Table.Head class="whitespace-nowrap">{header}</Table.Head>
                {/each}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each previewRows as row}
                <Table.Row>
                  {#each previewHeaders as _, idx}
                    <Table.Cell class="font-mono text-xs">{row[idx] ?? ""}</Table.Cell>
                  {/each}
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Column Mapping -->
  {#if previewHeaders.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>Column Mapping</Card.Title>
        <Card.Description>Map CSV columns to journal entry fields. For fixed account names, prefix with "=" (e.g. "=Assets:Bank:Checking").</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div class="space-y-1">
            <label for="delimiter" class="text-sm font-medium">Delimiter</label>
            <select id="delimiter" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={delimiter} onchange={updatePreview}>
              <option value=",">,  (comma)</option>
              <option value=";">; (semicolon)</option>
              <option value="&#9">Tab</option>
            </select>
          </div>
          <div class="space-y-1">
            <label for="dateFormat" class="text-sm font-medium">Date Format</label>
            <select id="dateFormat" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={dateFormat}>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            </select>
          </div>
          <div class="space-y-1">
            <label for="dateCol" class="text-sm font-medium">Date Column *</label>
            <select id="dateCol" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={dateColumn}>
              <option value="">-- select --</option>
              {#each previewHeaders as h}
                <option value={h}>{h}</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label for="descCol" class="text-sm font-medium">Description Column</label>
            <select id="descCol" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={descriptionColumn}>
              <option value="">-- none --</option>
              {#each previewHeaders as h}
                <option value={h}>{h}</option>
              {/each}
            </select>
          </div>
          <div class="space-y-1">
            <label for="currCol" class="text-sm font-medium">Currency Column</label>
            <Input id="currCol" placeholder="Column name or =USD" bind:value={currencyColumn} />
          </div>
        </div>

        <div class="border rounded-md p-4 space-y-3">
          <h4 class="text-sm font-semibold">Debit Line (positive amount)</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label for="debitAccount" class="text-sm font-medium">Account</label>
              <Input id="debitAccount" placeholder="Column name or =Expenses:Food" bind:value={debitAccountColumn} />
            </div>
            <div class="space-y-1">
              <label for="debitAmount" class="text-sm font-medium">Amount Column</label>
              <select id="debitAmount" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={debitAmountColumn}>
                <option value="">-- select --</option>
                {#each previewHeaders as h}
                  <option value={h}>{h}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>

        <div class="border rounded-md p-4 space-y-3">
          <h4 class="text-sm font-semibold">Credit Line (negated amount)</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label for="creditAccount" class="text-sm font-medium">Account</label>
              <Input id="creditAccount" placeholder="Column name or =Assets:Bank:Checking" bind:value={creditAccountColumn} />
            </div>
            <div class="space-y-1">
              <label for="creditAmount" class="text-sm font-medium">Amount Column</label>
              <select id="creditAmount" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" bind:value={creditAmountColumn}>
                <option value="">-- select --</option>
                {#each previewHeaders as h}
                  <option value={h}>{h}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Import button -->
  <div class="flex gap-3">
    <Button onclick={doImport} disabled={importing || !rawContent.trim()}>
      {importing ? "Importing..." : "Import"}
    </Button>
    <Button variant="outline" href="/journal">Back to Journal</Button>
  </div>

  <!-- Results -->
  {#if importResult}
    <Card.Root>
      <Card.Header>
        <Card.Title>Import Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-2">
        <div class="grid grid-cols-3 gap-4">
          <div class="text-center">
            <p class="text-2xl font-bold">{importResult.entries_created}</p>
            <p class="text-sm text-muted-foreground">Entries</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{importResult.accounts_created}</p>
            <p class="text-sm text-muted-foreground">Accounts Created</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{importResult.currencies_created}</p>
            <p class="text-sm text-muted-foreground">Currencies Created</p>
          </div>
        </div>
        {#if importResult.warnings.length > 0}
          <div class="mt-4">
            <h4 class="text-sm font-semibold mb-2">Warnings ({importResult.warnings.length})</h4>
            <div class="max-h-48 overflow-y-auto space-y-1">
              {#each importResult.warnings as warning}
                <p class="text-sm text-muted-foreground">{warning}</p>
              {/each}
            </div>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</div>
