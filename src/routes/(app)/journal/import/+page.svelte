<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Plus from "lucide-svelte/icons/plus";
  import type {
    LedgerImportResult,
    ChainInfo,
    EtherscanAccount,
    EtherscanSyncResult,
  } from "$lib/types/index.js";
  import { SUPPORTED_CHAINS } from "$lib/types/index.js";

  const settings = new SettingsStore();

  // -- Ledger file import state --
  let fileContent = $state("");
  let submitting = $state(false);
  let result = $state<LedgerImportResult | null>(null);
  let fileName = $state<string | null>(null);
  let previewLines = $derived(
    fileContent
      ? fileContent.split("\n").slice(0, 10).filter((l) => l.trim())
      : [],
  );

  // -- Etherscan state --
  let ethAccounts = $state<EtherscanAccount[]>([]);
  let selectedChainIds = $state<Set<number>>(new Set([1]));
  let newAddress = $state("");
  let newLabel = $state("");
  let addingAccount = $state(false);
  let syncingKey = $state<string | null>(null);
  let syncingAll = $state(false);
  let ethResult = $state<EtherscanSyncResult | null>(null);

  function accountSyncKey(account: EtherscanAccount): string {
    return `${account.address}:${account.chain_id}`;
  }

  function getChainName(chainId: number): string {
    const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
    return chain?.name ?? `Chain ${chainId}`;
  }

  // Load etherscan accounts on mount
  async function loadEthAccounts() {
    try {
      ethAccounts = await getBackend().listEtherscanAccounts();
    } catch (err) {
      toast.error(`Failed to load tracked addresses: ${err}`);
    }
  }

  $effect(() => {
    loadEthAccounts();
  });

  // -- Ledger file handlers --
  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    fileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      fileContent = (e.target?.result as string) ?? "";
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!fileContent.trim()) {
      toast.error("No ledger data to import");
      return;
    }

    submitting = true;
    result = null;

    try {
      result = await getBackend().importLedgerFile(fileContent);
      toast.success("Ledger file imported successfully");
    } catch (err) {
      toast.error(String(err));
    } finally {
      submitting = false;
    }
  }

  // -- Etherscan handlers --
  function toggleChain(chainId: number) {
    const next = new Set(selectedChainIds);
    if (next.has(chainId)) {
      next.delete(chainId);
    } else {
      next.add(chainId);
    }
    selectedChainIds = next;
  }

  async function handleAddEthAccount() {
    const addr = newAddress.trim();
    const label = newLabel.trim();
    if (!addr || !label) {
      toast.error("Address and label are required");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      toast.error("Invalid Ethereum address");
      return;
    }
    if (selectedChainIds.size === 0) {
      toast.error("Select at least one chain");
      return;
    }
    addingAccount = true;
    try {
      for (const chainId of selectedChainIds) {
        await getBackend().addEtherscanAccount(addr, chainId, label);
      }
      newAddress = "";
      newLabel = "";
      await loadEthAccounts();
      toast.success(`Address added to ${selectedChainIds.size} chain(s)`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      addingAccount = false;
    }
  }

  async function handleRemoveEthAccount(account: EtherscanAccount) {
    try {
      await getBackend().removeEtherscanAccount(account.address, account.chain_id);
      await loadEthAccounts();
      toast.success("Address removed");
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleSyncOne(account: EtherscanAccount) {
    const apiKey = settings.etherscanApiKey;
    if (!apiKey) {
      toast.error("Etherscan API key is required");
      return;
    }
    syncingKey = accountSyncKey(account);
    ethResult = null;
    try {
      ethResult = await getBackend().syncEtherscan(
        apiKey,
        account.address,
        account.label,
        account.chain_id,
      );
      toast.success(
        `Synced ${account.label} (${getChainName(account.chain_id)}): ${ethResult.transactions_imported} imported`,
      );
    } catch (err) {
      toast.error(String(err));
    } finally {
      syncingKey = null;
    }
  }

  async function handleSyncAll() {
    const apiKey = settings.etherscanApiKey;
    if (!apiKey) {
      toast.error("Etherscan API key is required");
      return;
    }
    if (ethAccounts.length === 0) {
      toast.error("No tracked addresses to sync");
      return;
    }
    syncingAll = true;
    ethResult = null;
    let totalImported = 0;
    let totalSkipped = 0;
    let totalAccountsCreated = 0;
    let allWarnings: string[] = [];

    try {
      for (const account of ethAccounts) {
        syncingKey = accountSyncKey(account);
        const r = await getBackend().syncEtherscan(
          apiKey,
          account.address,
          account.label,
          account.chain_id,
        );
        totalImported += r.transactions_imported;
        totalSkipped += r.transactions_skipped;
        totalAccountsCreated += r.accounts_created;
        allWarnings = allWarnings.concat(r.warnings);
      }
      ethResult = {
        transactions_imported: totalImported,
        transactions_skipped: totalSkipped,
        accounts_created: totalAccountsCreated,
        warnings: allWarnings,
      };
      toast.success(`Sync complete: ${totalImported} transactions imported`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      syncingKey = null;
      syncingAll = false;
    }
  }

  function formatAddress(addr: string): string {
    if (addr.length > 12) {
      return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    }
    return addr;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Import / Export</h1>
    <p class="text-muted-foreground">
      Import data from ledger files or sync transactions from external sources.
    </p>
  </div>

  <!-- Ledger File Import -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Ledger File</Card.Title>
      <Card.Description
        >Select a ledger file or paste the content directly.</Card.Description
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
            accept=".ledger,.beancount,.journal,.txt"
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
        <label for="ledger-data" class="text-sm font-medium">File Content</label>
        <textarea
          id="ledger-data"
          bind:value={fileContent}
          rows="10"
          class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={"2024-01-01 open Assets:Bank:Checking  USD\n2024-01-01 open Expenses:Food\n\n2024-01-15 * Grocery Store\n  Expenses:Food          50.00 USD\n  Assets:Bank:Checking  -50.00 USD"}
        ></textarea>
      </div>

      {#if previewLines.length > 0}
        <div class="rounded-md border bg-muted/50 p-3">
          <p class="mb-2 text-xs font-medium text-muted-foreground">Preview (first 10 lines)</p>
          <pre class="overflow-x-auto text-xs font-mono">{previewLines.join("\n")}</pre>
        </div>
      {/if}
    </Card.Content>
    <Card.Footer class="flex justify-between">
      <Button variant="outline" href="/journal">Cancel</Button>
      <Button
        onclick={handleImport}
        disabled={submitting || !fileContent.trim()}
      >
        {submitting ? "Importing..." : "Import"}
      </Button>
    </Card.Footer>
  </Card.Root>

  {#if result}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Import Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
        </div>

        {#if result.warnings.length > 0}
          <div class="mt-4">
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

        <div class="mt-4 flex gap-2">
          <Button variant="outline" size="sm" href="/journal">View Journal</Button>
          <Button variant="outline" size="sm" href="/accounts">View Accounts</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Blockchain Sync -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Blockchain Sync (Etherscan)</Card.Title>
      <Card.Description>Sync native transactions from tracked addresses across multiple chains.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- API Key -->
      <div class="space-y-2">
        <label for="etherscan-api-key" class="text-sm font-medium">API Key</label>
        <Input
          id="etherscan-api-key"
          type="password"
          placeholder="Etherscan API key"
          value={settings.etherscanApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ etherscanApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Get a free API key at <a
            href="https://etherscan.io/apis"
            target="_blank"
            class="underline hover:text-foreground">etherscan.io</a
          >. One key works for all supported chains.
        </p>
      </div>

      <!-- Tracked Addresses Table -->
      {#if ethAccounts.length > 0}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Address</Table.Head>
              <Table.Head>Chain</Table.Head>
              <Table.Head>Label</Table.Head>
              <Table.Head class="text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each ethAccounts as account}
              {@const key = accountSyncKey(account)}
              <Table.Row>
                <Table.Cell class="font-mono text-sm">{formatAddress(account.address)}</Table.Cell>
                <Table.Cell>
                  <Badge variant="secondary">{getChainName(account.chain_id)}</Badge>
                </Table.Cell>
                <Table.Cell>{account.label}</Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => handleSyncOne(account)}
                      disabled={syncingKey !== null || syncingAll}
                    >
                      <RefreshCw class="mr-1 h-3 w-3" />
                      {syncingKey === key ? "Syncing..." : "Sync"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => handleRemoveEthAccount(account)}
                      disabled={syncingKey !== null || syncingAll}
                    >
                      <Trash2 class="h-3 w-3" />
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {:else}
        <p class="text-sm text-muted-foreground">No tracked addresses yet. Add one below.</p>
      {/if}

      <!-- Add Address Form -->
      <div class="space-y-3">
        <div class="flex items-end gap-2">
          <div class="flex-1 space-y-1">
            <label for="new-eth-address" class="text-xs font-medium">Address</label>
            <Input
              id="new-eth-address"
              placeholder="0x..."
              bind:value={newAddress}
            />
          </div>
          <div class="flex-1 space-y-1">
            <label for="new-eth-label" class="text-xs font-medium">Label</label>
            <Input
              id="new-eth-label"
              placeholder="My Wallet"
              bind:value={newLabel}
            />
          </div>
          <Button
            onclick={handleAddEthAccount}
            disabled={addingAccount || !newAddress.trim() || !newLabel.trim() || selectedChainIds.size === 0}
          >
            <Plus class="mr-1 h-4 w-4" />
            Add
          </Button>
        </div>

        <!-- Chain selector -->
        {#if SUPPORTED_CHAINS.length > 0}
          <div class="space-y-1">
            <span class="text-xs font-medium">Chains</span>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              {#each SUPPORTED_CHAINS as chain}
                <label class="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedChainIds.has(chain.chain_id)}
                    onchange={() => toggleChain(chain.chain_id)}
                    class="rounded border-input"
                  />
                  {chain.name} ({chain.native_currency})
                </label>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </Card.Content>
    <Card.Footer class="flex justify-between">
      <Button variant="outline" href="/journal">Back</Button>
      <Button
        onclick={handleSyncAll}
        disabled={syncingAll || syncingKey !== null || ethAccounts.length === 0 || !settings.etherscanApiKey}
      >
        <RefreshCw class="mr-1 h-4 w-4" />
        {syncingAll ? "Syncing All..." : "Sync All"}
      </Button>
    </Card.Footer>
  </Card.Root>

  <!-- Etherscan Sync Results -->
  {#if ethResult}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Sync Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-3 gap-4">
          <div class="text-center">
            <p class="text-2xl font-bold">{ethResult.transactions_imported}</p>
            <p class="text-xs text-muted-foreground">Imported</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{ethResult.transactions_skipped}</p>
            <p class="text-xs text-muted-foreground">Skipped</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{ethResult.accounts_created}</p>
            <p class="text-xs text-muted-foreground">Accounts Created</p>
          </div>
        </div>

        {#if ethResult.warnings.length > 0}
          <div class="mt-4">
            <p class="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Warnings ({ethResult.warnings.length})
            </p>
            <ul class="mt-1 max-h-40 overflow-y-auto text-xs text-muted-foreground">
              {#each ethResult.warnings as warning}
                <li class="py-0.5">{warning}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="mt-4 flex gap-2">
          <Button variant="outline" size="sm" href="/journal">View Journal</Button>
          <Button variant="outline" size="sm" href="/accounts">View Accounts</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
