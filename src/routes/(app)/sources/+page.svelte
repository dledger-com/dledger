<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { cn } from "$lib/utils.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Plus from "lucide-svelte/icons/plus";
  import Check from "lucide-svelte/icons/check";
  import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
  import X from "lucide-svelte/icons/x";
  import {
    syncExchangeRates,
    fetchSingleRate,
    type ExchangeRateSyncResult,
    type SourceName,
  } from "$lib/exchange-rate-sync.js";
  import {
    findMissingRates,
    fetchHistoricalRates,
    type HistoricalRateRequest,
    type HistoricalFetchResult,
  } from "$lib/exchange-rate-historical.js";
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
  let chainPopoverOpen = $state(false);
  let newAddress = $state("");
  let newLabel = $state("");
  let addingAccount = $state(false);
  let syncingKey = $state<string | null>(null);
  let syncingAll = $state(false);
  let ethResult = $state<EtherscanSyncResult | null>(null);

  // -- Post-import missing rate backfill state --
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);
  let fetchingMissingRates = $state(false);
  let missingRateResult = $state<HistoricalFetchResult | null>(null);
  let missingRateProgress = $state({ fetched: 0, total: 0 });

  // -- Exchange rate sync state --
  let syncingRates = $state(false);
  let rateResult = $state<ExchangeRateSyncResult | null>(null);
  let pendingChoices = $state<{ currency: string; sources: string[]; selected: string }[]>([]);
  let savingPreferences = $state(false);

  // -- Historical backfill state --
  let backfillCurrencies = $state<string[]>([]);
  let backfillFromDate = $state("");
  let backfillToDate = $state(new Date().toISOString().slice(0, 10));
  let backfilling = $state(false);
  let backfillResult = $state<HistoricalFetchResult | null>(null);
  let backfillProgress = $state({ fetched: 0, total: 0 });
  let availableCurrencies = $state<string[]>([]);

  async function loadAvailableCurrencies() {
    try {
      const currencies = await getBackend().listCurrencies();
      const baseCurrency = settings.currency;
      availableCurrencies = currencies
        .map((c) => c.code)
        .filter((c) => c !== baseCurrency && !settings.hiddenCurrencySet.has(c))
        .sort();
    } catch {
      // ignore
    }
  }

  function toggleBackfillCurrency(code: string) {
    if (backfillCurrencies.includes(code)) {
      backfillCurrencies = backfillCurrencies.filter((c) => c !== code);
    } else {
      backfillCurrencies = [...backfillCurrencies, code];
    }
  }

  async function handleBackfill() {
    if (backfillCurrencies.length === 0 || !backfillFromDate || !backfillToDate) {
      toast.error("Select currencies and date range");
      return;
    }

    backfilling = true;
    backfillResult = null;
    backfillProgress = { fetched: 0, total: 0 };

    try {
      // Generate date targets for each currency
      const currencyDates: { currency: string; date: string }[] = [];
      for (const currency of backfillCurrencies) {
        let current = new Date(backfillFromDate);
        const end = new Date(backfillToDate);
        while (current <= end) {
          currencyDates.push({ currency, date: current.toISOString().slice(0, 10) });
          current.setDate(current.getDate() + 1);
        }
      }

      const missing = await findMissingRates(
        getBackend(),
        settings.currency,
        currencyDates,
        settings.rateSources,
      );

      if (missing.length === 0) {
        toast.success("All rates already available for the selected range");
        backfilling = false;
        return;
      }

      const totalDates = missing.reduce((sum, r) => sum + r.dates.length, 0);
      backfillProgress = { fetched: 0, total: totalDates };

      backfillResult = await fetchHistoricalRates(
        getBackend(),
        missing,
        {
          baseCurrency: settings.currency,
          coingeckoApiKey: settings.coingeckoApiKey,
          finnhubApiKey: settings.finnhubApiKey,
          onProgress: (fetched, total) => {
            backfillProgress = { fetched, total };
          },
        },
      );

      if (backfillResult.errors.length > 0) {
        toast.warning(`Fetched ${backfillResult.fetched} rate(s) with ${backfillResult.errors.length} warning(s)`);
      } else {
        toast.success(`Fetched ${backfillResult.fetched} historical rate(s)`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      backfilling = false;
    }
  }

  async function handleSyncRates() {
    syncingRates = true;
    rateResult = null;
    pendingChoices = [];
    try {
      rateResult = await syncExchangeRates(
        getBackend(),
        settings.currency,
        settings.coingeckoApiKey,
        settings.finnhubApiKey,
        settings.hiddenCurrencySet,
        settings.rateSources,
        settings.initializedRateSources,
      );

      // Persist updated source maps
      settings.update({
        rateSources: rateResult.updatedRateSources,
        initializedRateSources: rateResult.updatedInitializedSources,
      });

      // Build pending choices with default selection
      if (rateResult.pendingChoices.length > 0) {
        pendingChoices = rateResult.pendingChoices.map((pc) => ({
          currency: pc.currency,
          sources: pc.sources,
          selected: pc.sources[0],
        }));
      }

      if (rateResult.errors.length > 0) {
        toast.warning(
          `Synced ${rateResult.rates_fetched} rate(s) with ${rateResult.errors.length} warning(s)`,
        );
      } else {
        toast.success(`Synced ${rateResult.rates_fetched} exchange rate(s)`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      syncingRates = false;
    }
  }

  async function handleSavePreferences() {
    const updated = { ...settings.rateSources };
    for (const choice of pendingChoices) {
      if (updated[choice.currency]) {
        updated[choice.currency] = {
          ...updated[choice.currency],
          preferred: choice.selected,
        };
      }
    }
    settings.update({ rateSources: updated });

    // Refetch rates from newly selected sources
    savingPreferences = true;
    const errors: string[] = [];
    let fetched = 0;
    try {
      for (const choice of pendingChoices) {
        const res = await fetchSingleRate(
          getBackend(),
          choice.currency,
          choice.selected as SourceName,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
        );
        if (res.success) {
          fetched++;
        } else if (res.error) {
          errors.push(res.error);
        }
      }
      if (errors.length > 0) {
        toast.warning(`Preferences saved. Fetched ${fetched} rate(s) with ${errors.length} error(s): ${errors.join("; ")}`);
      } else {
        toast.success(`Preferences saved and ${fetched} rate(s) fetched`);
      }
    } catch (err) {
      toast.error(`Preferences saved but refetch failed: ${err}`);
    } finally {
      savingPreferences = false;
      pendingChoices = [];
    }
  }

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
    loadAvailableCurrencies();
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
    missingRateRequests = [];
    missingRateResult = null;

    try {
      result = await getBackend().importLedgerFile(fileContent);
      toast.success("Ledger file imported successfully");

      // Check for missing historical rates
      if (result.transaction_currency_dates && result.transaction_currency_dates.length > 0) {
        const currencyDates = result.transaction_currency_dates.map(([currency, date]) => ({ currency, date }));
        const missing = await findMissingRates(
          getBackend(),
          settings.currency,
          currencyDates,
          settings.rateSources,
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

  async function handleFetchMissingRates() {
    fetchingMissingRates = true;
    missingRateResult = null;
    const totalDates = missingRateRequests.reduce((sum, r) => sum + r.dates.length, 0);
    missingRateProgress = { fetched: 0, total: totalDates };
    try {
      missingRateResult = await fetchHistoricalRates(
        getBackend(),
        missingRateRequests,
        {
          baseCurrency: settings.currency,
          coingeckoApiKey: settings.coingeckoApiKey,
          finnhubApiKey: settings.finnhubApiKey,
          onProgress: (fetched, total) => {
            missingRateProgress = { fetched, total };
          },
        },
      );
      missingRateRequests = [];
      if (missingRateResult.errors.length > 0) {
        toast.warning(`Fetched ${missingRateResult.fetched} rate(s) with ${missingRateResult.errors.length} warning(s)`);
      } else {
        toast.success(`Fetched ${missingRateResult.fetched} historical rate(s)`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      fetchingMissingRates = false;
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
    <h1 class="text-2xl font-bold tracking-tight">Sources</h1>
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

  <!-- Missing Historical Rates Banner -->
  {#if missingRateRequests.length > 0}
    {@const totalMissing = missingRateRequests.reduce((sum, r) => sum + r.dates.length, 0)}
    <Card.Root class="border-amber-200 dark:border-amber-800">
      <Card.Header>
        <Card.Title>Missing Historical Rates</Card.Title>
        <Card.Description>
          {totalMissing} historical rate(s) missing for {missingRateRequests.length} currency(ies).
          Fetch them for accurate currency conversion.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-wrap gap-2">
          {#each missingRateRequests as req}
            <Badge variant="secondary">{req.currency} ({req.dates.length} date{req.dates.length === 1 ? "" : "s"})</Badge>
          {/each}
        </div>
        {#if fetchingMissingRates}
          <div class="mt-3">
            <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                class="h-full bg-primary transition-all duration-300"
                style="width: {missingRateProgress.total > 0 ? (missingRateProgress.fetched / missingRateProgress.total * 100) : 0}%"
              ></div>
            </div>
            <p class="text-xs text-muted-foreground mt-1">
              {missingRateProgress.fetched} / {missingRateProgress.total}
            </p>
          </div>
        {/if}
      </Card.Content>
      <Card.Footer class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { missingRateRequests = []; }}>Skip</Button>
        <Button onclick={handleFetchMissingRates} disabled={fetchingMissingRates}>
          {fetchingMissingRates ? "Fetching..." : "Fetch Now"}
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}

  {#if missingRateResult}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Historical Rate Fetch Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div class="text-center">
            <p class="text-2xl font-bold">{missingRateResult.fetched}</p>
            <p class="text-xs text-muted-foreground">Fetched</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{missingRateResult.skipped}</p>
            <p class="text-xs text-muted-foreground">Skipped</p>
          </div>
          {#if missingRateResult.errors.length > 0}
            <div class="text-center">
              <p class="text-2xl font-bold text-yellow-600">{missingRateResult.errors.length}</p>
              <p class="text-xs text-muted-foreground">Errors</p>
            </div>
          {/if}
        </div>
        {#if missingRateResult.errors.length > 0}
          <ul class="mt-2 max-h-40 overflow-y-auto text-xs text-muted-foreground">
            {#each missingRateResult.errors as error}
              <li class="py-0.5">{error}</li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Blockchain Sync -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Etherscan (Ethereum and derivatives)</Card.Title>
      <Card.Description>Sync transactions and token transfers from tracked addresses across multiple chains.</Card.Description>
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
        <div class="space-y-2">
          <span class="text-xs font-medium">Chains</span>
          <Popover.Root bind:open={chainPopoverOpen}>
            <Popover.Trigger>
              <Button variant="outline" class="w-[300px] justify-between">
                {#if selectedChainIds.size === 0}
                  Select chains...
                {:else}
                  {selectedChainIds.size} chain{selectedChainIds.size === 1 ? "" : "s"} selected
                {/if}
                <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </Popover.Trigger>
            <Popover.Content class="w-[300px] p-0">
              <Command.Root>
                <Command.Input placeholder="Search chains..." />
                <Command.List>
                  <Command.Empty>No chain found.</Command.Empty>
                  <Command.Group>
                    {#each SUPPORTED_CHAINS as chain}
                      <Command.Item
                        value={chain.name}
                        onSelect={() => toggleChain(chain.chain_id)}
                      >
                        <Check
                          class={cn(
                            "mr-2 h-4 w-4",
                            selectedChainIds.has(chain.chain_id) ? "opacity-100" : "opacity-0"
                          )}
                        />
                        {chain.name} ({chain.native_currency})
                      </Command.Item>
                    {/each}
                  </Command.Group>
                </Command.List>
              </Command.Root>
            </Popover.Content>
          </Popover.Root>

          {#if selectedChainIds.size > 0}
            <div class="flex flex-wrap gap-1">
              {#each SUPPORTED_CHAINS.filter((c) => selectedChainIds.has(c.chain_id)) as chain}
                <Badge variant="secondary" class="gap-1">
                  {chain.name}
                  <button onclick={() => toggleChain(chain.chain_id)} class="ml-0.5 rounded-full outline-none hover:bg-muted">
                    <X class="h-3 w-3" />
                  </button>
                </Badge>
              {/each}
            </div>
          {/if}
        </div>
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

  <!-- Exchange Rates -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Exchange Rates</Card.Title>
      <Card.Description>Fetch latest rates for currencies in your ledger. Fiat from ECB via Frankfurter. Crypto from CoinGecko. Stocks from Finnhub.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="space-y-2">
        <label for="coingecko-api-key" class="text-sm font-medium">CoinGecko API Key</label>
        <Input
          id="coingecko-api-key"
          type="password"
          placeholder="CoinGecko demo API key (optional)"
          value={settings.coingeckoApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ coingeckoApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Get a free demo key at <a
            href="https://www.coingecko.com/en/api"
            target="_blank"
            class="underline hover:text-foreground">coingecko.com</a
          >. Required for crypto rates. Fiat rates work without a key.
        </p>
      </div>

      <div class="space-y-2">
        <label for="finnhub-api-key" class="text-sm font-medium">Finnhub API Key</label>
        <Input
          id="finnhub-api-key"
          type="password"
          placeholder="Finnhub API key (optional)"
          value={settings.finnhubApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ finnhubApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Get a free key at <a href="https://finnhub.io" target="_blank"
            class="underline hover:text-foreground">finnhub.io</a>.
          Required for stock prices (AAPL, GOOG, etc.).
        </p>
      </div>

      <p class="text-sm text-muted-foreground">
        Base currency: <strong>{settings.currency}</strong>
        <a href="/settings" class="ml-1 underline hover:text-foreground">Change</a>
      </p>
    </Card.Content>
    <Card.Footer class="flex justify-between">
      <Button variant="outline" href="/journal">Back</Button>
      <Button
        onclick={handleSyncRates}
        disabled={syncingRates}
      >
        <RefreshCw class="mr-1 h-4 w-4" />
        {syncingRates ? "Syncing..." : "Sync Rates"}
      </Button>
    </Card.Footer>
  </Card.Root>

  {#if rateResult}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Rate Sync Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-2 gap-4">
          <div class="text-center">
            <p class="text-2xl font-bold">{rateResult.rates_fetched}</p>
            <p class="text-xs text-muted-foreground">Fetched</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{rateResult.rates_skipped}</p>
            <p class="text-xs text-muted-foreground">Skipped</p>
          </div>
        </div>

        {#if rateResult.errors.length > 0}
          <div class="mt-4">
            <p class="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Warnings ({rateResult.errors.length})
            </p>
            <ul class="mt-1 max-h-40 overflow-y-auto text-xs text-muted-foreground">
              {#each rateResult.errors as error}
                <li class="py-0.5">{error}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  {#if pendingChoices.length > 0}
    <Card.Root class="border-blue-200 dark:border-blue-800">
      <Card.Header>
        <Card.Title>Source Selection</Card.Title>
        <Card.Description>
          Multiple rate sources found for these currencies. Choose your preferred source for each.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Currency</Table.Head>
              <Table.Head>Available Sources</Table.Head>
              <Table.Head>Preferred</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each pendingChoices as choice, i}
              <Table.Row>
                <Table.Cell class="font-mono">{choice.currency}</Table.Cell>
                <Table.Cell>
                  {choice.sources.join(", ")}
                </Table.Cell>
                <Table.Cell>
                  <select
                    value={choice.selected}
                    onchange={(e) => {
                      const val = (e.target as HTMLSelectElement).value;
                      pendingChoices[i] = { ...choice, selected: val };
                    }}
                    class="flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  >
                    {#each choice.sources as src}
                      <option value={src}>{src}</option>
                    {/each}
                  </select>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
      <Card.Footer class="flex justify-end">
        <Button onclick={handleSavePreferences} disabled={savingPreferences}>
          {savingPreferences ? "Saving..." : "Save Preferences"}
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}

  <!-- Historical Backfill -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Historical Backfill</Card.Title>
      <Card.Description>Fetch historical exchange rates for a date range. Frankfurter (fiat) returns the full timeseries in one call. CoinGecko and Finnhub fetch per-currency.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <!-- Currency selection -->
      <div class="space-y-2">
        <span class="text-sm font-medium">Currencies</span>
        {#if availableCurrencies.length === 0}
          <p class="text-sm text-muted-foreground">No non-base currencies found. Import data first.</p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each availableCurrencies as code}
              <button
                onclick={() => toggleBackfillCurrency(code)}
                class={`inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-medium border transition-colors cursor-pointer ${backfillCurrencies.includes(code)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-input hover:bg-accent"
                }`}
              >
                {code}
              </button>
            {/each}
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={() => { backfillCurrencies = [...availableCurrencies]; }}>Select All</Button>
            <Button variant="outline" size="sm" onclick={() => { backfillCurrencies = []; }}>Clear</Button>
          </div>
        {/if}
      </div>

      <!-- Date range -->
      <div class="flex items-end gap-4">
        <div class="space-y-1">
          <label for="backfill-from" class="text-xs font-medium">From</label>
          <Input id="backfill-from" type="date" bind:value={backfillFromDate} class="w-44" />
        </div>
        <div class="space-y-1">
          <label for="backfill-to" class="text-xs font-medium">To</label>
          <Input id="backfill-to" type="date" bind:value={backfillToDate} class="w-44" />
        </div>
      </div>

      {#if backfilling}
        <div>
          <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              class="h-full bg-primary transition-all duration-300"
              style="width: {backfillProgress.total > 0 ? (backfillProgress.fetched / backfillProgress.total * 100) : 0}%"
            ></div>
          </div>
          <p class="text-xs text-muted-foreground mt-1">
            {backfillProgress.fetched} / {backfillProgress.total} rates
          </p>
        </div>
      {/if}
    </Card.Content>
    <Card.Footer class="flex justify-end">
      <Button
        onclick={handleBackfill}
        disabled={backfilling || backfillCurrencies.length === 0 || !backfillFromDate || !backfillToDate}
      >
        {backfilling ? "Fetching..." : "Fetch Historical Rates"}
      </Button>
    </Card.Footer>
  </Card.Root>

  {#if backfillResult}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Backfill Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div class="text-center">
            <p class="text-2xl font-bold">{backfillResult.fetched}</p>
            <p class="text-xs text-muted-foreground">Fetched</p>
          </div>
          <div class="text-center">
            <p class="text-2xl font-bold">{backfillResult.skipped}</p>
            <p class="text-xs text-muted-foreground">Skipped</p>
          </div>
          {#if backfillResult.errors.length > 0}
            <div class="text-center">
              <p class="text-2xl font-bold text-yellow-600">{backfillResult.errors.length}</p>
              <p class="text-xs text-muted-foreground">Errors</p>
            </div>
          {/if}
        </div>
        {#if backfillResult.errors.length > 0}
          <ul class="mt-2 max-h-40 overflow-y-auto text-xs text-muted-foreground">
            {#each backfillResult.errors as error}
              <li class="py-0.5">{error}</li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</div>
