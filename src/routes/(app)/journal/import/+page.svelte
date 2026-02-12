<script lang="ts">
  import { goto } from "$app/navigation";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { getBackend } from "$lib/backend.js";
  import { toast } from "svelte-sonner";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";

  let csvData = $state("");
  let account = $state("Assets:Bank:Checking");
  let contraAccount = $state("Expenses:Uncategorized");
  let currency = $state("EUR");
  let dateColumn = $state(0);
  let descriptionColumn = $state(1);
  let amountColumn = $state(2);
  let dateFormat = $state("%Y-%m-%d");
  let skipHeader = $state(true);
  let delimiter = $state(",");
  let submitting = $state(false);
  let result = $state<string | null>(null);
  let fileName = $state<string | null>(null);
  let previewLines = $derived(
    csvData
      ? csvData.split("\n").slice(0, 6).filter((l) => l.trim())
      : [],
  );

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    fileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      csvData = (e.target?.result as string) ?? "";

      // Auto-detect delimiter
      const firstLine = csvData.split("\n")[0] ?? "";
      if (firstLine.includes("\t")) delimiter = "\t";
      else if (firstLine.includes(";")) delimiter = ";";
      else delimiter = ",";
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!csvData.trim()) {
      toast.error("No CSV data to import");
      return;
    }

    submitting = true;
    result = null;

    try {
      const summary = await getBackend().importCsv({
        csvData,
        account,
        contraAccount,
        currency,
        dateColumn,
        descriptionColumn,
        amountColumn,
        dateFormat,
        skipHeader,
        delimiter,
      });
      result = summary;
      toast.success("CSV imported successfully");
    } catch (err) {
      toast.error(String(err));
    } finally {
      submitting = false;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Import CSV</h1>
    <p class="text-muted-foreground">
      Import transactions from a CSV bank statement.
    </p>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>CSV File</Card.Title>
      <Card.Description
        >Select a CSV file or paste the content directly.</Card.Description
      >
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center gap-4">
        <label
          class="flex cursor-pointer items-center gap-2 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
        >
          <Upload class="h-4 w-4" />
          <span>Choose file</span>
          <input
            type="file"
            accept=".csv,.tsv,.txt"
            class="hidden"
            onchange={handleFileSelect}
          />
        </label>
        {#if fileName}
          <span class="flex items-center gap-1 text-sm text-muted-foreground">
            <FileText class="h-4 w-4" />
            {fileName}
          </span>
        {/if}
      </div>

      <div class="space-y-2">
        <label for="csv-data" class="text-sm font-medium">CSV Content</label>
        <textarea
          id="csv-data"
          bind:value={csvData}
          rows="6"
          class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Date,Description,Amount&#10;2025-01-15,Grocery Store,-50.00&#10;2025-01-16,Salary,3000.00"
        ></textarea>
      </div>

      {#if previewLines.length > 0}
        <div class="rounded-md border bg-muted/50 p-3">
          <p class="mb-2 text-xs font-medium text-muted-foreground">Preview</p>
          <div class="overflow-x-auto">
            <table class="text-xs font-mono">
              <tbody>
                {#each previewLines as line, i}
                  <tr class={i === 0 && skipHeader ? "text-muted-foreground" : ""}>
                    <td class="pr-2 text-muted-foreground">{i}</td>
                    {#each line.split(delimiter === "\t" ? "\t" : delimiter) as cell}
                      <td class="border-l border-border px-2">{cell.trim()}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Column Mapping</Card.Title>
      <Card.Description
        >Map CSV columns to transaction fields (0-based index).</Card.Description
      >
    </Card.Header>
    <Card.Content>
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="space-y-2">
          <label for="date-col" class="text-sm font-medium">Date Column</label>
          <Input id="date-col" type="number" min="0" bind:value={dateColumn} />
        </div>
        <div class="space-y-2">
          <label for="desc-col" class="text-sm font-medium"
            >Description Column</label
          >
          <Input
            id="desc-col"
            type="number"
            min="0"
            bind:value={descriptionColumn}
          />
        </div>
        <div class="space-y-2">
          <label for="amount-col" class="text-sm font-medium"
            >Amount Column</label
          >
          <Input
            id="amount-col"
            type="number"
            min="0"
            bind:value={amountColumn}
          />
        </div>
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-3">
        <div class="space-y-2">
          <label for="date-format" class="text-sm font-medium"
            >Date Format</label
          >
          <select
            id="date-format"
            bind:value={dateFormat}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value="%Y-%m-%d">YYYY-MM-DD</option>
            <option value="%d/%m/%Y">DD/MM/YYYY</option>
            <option value="%m/%d/%Y">MM/DD/YYYY</option>
            <option value="%d.%m.%Y">DD.MM.YYYY</option>
          </select>
        </div>
        <div class="space-y-2">
          <label for="delim" class="text-sm font-medium">Delimiter</label>
          <select
            id="delim"
            bind:value={delimiter}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value=",">Comma (,)</option>
            <option value=";">Semicolon (;)</option>
            <option value="\t">Tab</option>
          </select>
        </div>
        <div class="flex items-end space-y-2">
          <label class="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" bind:checked={skipHeader} class="rounded" />
            Skip header row
          </label>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Account Mapping</Card.Title>
      <Card.Description
        >Specify the accounts for imported transactions.</Card.Description
      >
    </Card.Header>
    <Card.Content>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <label for="account" class="text-sm font-medium">Bank Account</label>
          <Input
            id="account"
            bind:value={account}
            placeholder="Assets:Bank:Checking"
          />
          <p class="text-xs text-muted-foreground">
            The account this CSV belongs to.
          </p>
        </div>
        <div class="space-y-2">
          <label for="contra" class="text-sm font-medium"
            >Default Contra Account</label
          >
          <Input
            id="contra"
            bind:value={contraAccount}
            placeholder="Expenses:Uncategorized"
          />
          <p class="text-xs text-muted-foreground">
            Counterparty for all transactions.
          </p>
        </div>
      </div>
      <div class="mt-4 space-y-2">
        <label for="currency" class="text-sm font-medium">Currency</label>
        <Input
          id="currency"
          bind:value={currency}
          placeholder="EUR"
          class="max-w-[200px]"
        />
      </div>
    </Card.Content>
    <Card.Footer class="flex justify-between">
      <Button variant="outline" href="/journal">Cancel</Button>
      <Button
        onclick={handleImport}
        disabled={submitting || !csvData.trim()}
      >
        {submitting ? "Importing..." : "Import Transactions"}
      </Button>
    </Card.Footer>
  </Card.Root>

  {#if result}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Content class="pt-6">
        <p class="text-sm text-green-700 dark:text-green-300">{result}</p>
        <div class="mt-4 flex gap-2">
          <Button variant="outline" size="sm" href="/journal"
            >View Journal</Button
          >
          <Button variant="outline" size="sm" href="/accounts"
            >View Accounts</Button
          >
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
