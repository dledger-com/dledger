<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getHiddenCurrencySet, markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
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
  import {
    getDefaultRegistry,
    dryRunReprocess,
    applyReprocess,
    type ReprocessResult,
    type ReprocessChange,
  } from "$lib/handlers/index.js";
  import RotateCw from "lucide-svelte/icons/rotate-cw";

  const handlerRegistry = getDefaultRegistry();
  const handlers = handlerRegistry.getAll();

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

  // -- Reprocess state --
  let reprocessing = $state(false);
  let reprocessPreview = $state<ReprocessResult | null>(null);
  let reprocessTarget = $state<{ chainId: number; address: string; label: string } | null>(null);
  let reprocessProgress = $state({ processed: 0, total: 0 });
  let applyingReprocess = $state(false);
  let reprocessApplyResult = $state<ReprocessResult | null>(null);

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
      const backend = getBackend();
      const currencies = await backend.listCurrencies();
      const baseCurrency = settings.currency;
      const rateSources = await backend.getCurrencyRateSources();
      const rateSourceMap = new Map(rateSources.map((rs) => [rs.currency, rs]));
      availableCurrencies = currencies
        .map((c) => c.code)
        .filter((c) => c !== baseCurrency && !getHiddenCurrencySet().has(c))
        .filter((c) => rateSourceMap.get(c)?.rate_source !== "none")
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
    try {
      const backend = getBackend();

      rateResult = await syncExchangeRates(
        backend,
        settings.currency,
        settings.coingeckoApiKey,
        settings.finnhubApiKey,
        getHiddenCurrencySet(),
      );

      // Update last sync time
      settings.update({ lastRateSync: new Date().toISOString().slice(0, 10) });

      // Auto-hide unrecognized currencies
      if (rateResult.autoHidden.length > 0) {
        for (const code of rateResult.autoHidden) {
          await markCurrencyHidden(getBackend(), code);
        }
        toast.info(`Auto-hid ${rateResult.autoHidden.length} unrecognized currency(ies)`);
        loadAvailableCurrencies();
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
      // Group accounts by chain_id for parallel sync across chains
      const byChain = new Map<number, EtherscanAccount[]>();
      for (const account of ethAccounts) {
        let list = byChain.get(account.chain_id);
        if (!list) {
          list = [];
          byChain.set(account.chain_id, list);
        }
        list.push(account);
      }

      // Sync chains in parallel (sequential within each chain for per-API-host rate limits)
      const chainResults = await Promise.all(
        [...byChain.values()].map(async (chainAccounts) => {
          const results: EtherscanSyncResult[] = [];
          for (const account of chainAccounts) {
            syncingKey = accountSyncKey(account);
            const r = await getBackend().syncEtherscan(
              apiKey,
              account.address,
              account.label,
              account.chain_id,
            );
            results.push(r);
          }
          return results;
        }),
      );

      for (const results of chainResults) {
        for (const r of results) {
          totalImported += r.transactions_imported;
          totalSkipped += r.transactions_skipped;
          totalAccountsCreated += r.accounts_created;
          allWarnings = allWarnings.concat(r.warnings);
        }
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

  async function handleReprocessOne(account: EtherscanAccount) {
    reprocessing = true;
    reprocessPreview = null;
    reprocessApplyResult = null;
    reprocessTarget = { chainId: account.chain_id, address: account.address, label: account.label };
    reprocessProgress = { processed: 0, total: 0 };
    try {
      reprocessPreview = await dryRunReprocess(getBackend(), handlerRegistry, {
        chainId: account.chain_id,
        address: account.address,
        label: account.label,
        settings: settings.settings,
        onProgress: (processed, total) => {
          reprocessProgress = { processed, total };
        },
      });
      if (reprocessPreview.changed === 0) {
        toast.success("All transactions unchanged — nothing to reprocess");
      }
    } catch (err) {
      toast.error(String(err));
      reprocessTarget = null;
    } finally {
      reprocessing = false;
    }
  }

  async function handleReprocessAll() {
    if (ethAccounts.length === 0) return;
    reprocessing = true;
    reprocessPreview = null;
    reprocessApplyResult = null;
    reprocessTarget = null;
    reprocessProgress = { processed: 0, total: 0 };

    const combined: ReprocessResult = {
      total: 0,
      unchanged: 0,
      changed: 0,
      skipped: 0,
      errors: [],
      changes: [],
      currencyHints: {},
    };

    try {
      for (const account of ethAccounts) {
        const r = await dryRunReprocess(getBackend(), handlerRegistry, {
          chainId: account.chain_id,
          address: account.address,
          label: account.label,
          settings: settings.settings,
          onProgress: (processed, total) => {
            reprocessProgress = { processed: combined.total + processed, total: combined.total + total };
          },
        });
        combined.total += r.total;
        combined.unchanged += r.unchanged;
        combined.changed += r.changed;
        combined.skipped += r.skipped;
        combined.errors.push(...r.errors);
        combined.changes.push(...r.changes);
        combined.currencyHints = { ...combined.currencyHints, ...r.currencyHints };
      }
      reprocessPreview = combined;
      if (combined.changed === 0) {
        toast.success("All transactions unchanged — nothing to reprocess");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      reprocessing = false;
    }
  }

  async function handleApplyReprocess() {
    if (!reprocessPreview || reprocessPreview.changes.length === 0) return;
    applyingReprocess = true;
    reprocessApplyResult = null;
    reprocessProgress = { processed: 0, total: 0 };

    // Group changes by chainId (derived from reprocessTarget or from changes)
    // If reprocessTarget is set, apply for that single account; else iterate all accounts
    const combined: ReprocessResult = {
      total: 0,
      unchanged: 0,
      changed: 0,
      skipped: 0,
      errors: [],
      changes: [],
      currencyHints: {},
    };

    try {
      if (reprocessTarget) {
        const r = await applyReprocess(getBackend(), handlerRegistry, {
          chainId: reprocessTarget.chainId,
          address: reprocessTarget.address,
          label: reprocessTarget.label,
          settings: settings.settings,
          onProgress: (processed, total) => {
            reprocessProgress = { processed, total };
          },
        }, reprocessPreview.changes);
        combined.total += r.total;
        combined.changed += r.changed;
        combined.errors.push(...r.errors);
      } else {
        // "Reprocess All" — re-run apply per account with all changes.
        // applyReprocess only processes hashes present in the changes list,
        // so passing the full list to each account is safe.
        for (const account of ethAccounts) {
          const r = await applyReprocess(getBackend(), handlerRegistry, {
            chainId: account.chain_id,
            address: account.address,
            label: account.label,
            settings: settings.settings,
            onProgress: (processed, total) => {
              reprocessProgress = { processed: combined.changed + processed, total: reprocessPreview!.changes.length };
            },
          }, reprocessPreview.changes);
          combined.total += r.total;
          combined.changed += r.changed;
          combined.errors.push(...r.errors);
        }
      }

      // Rebuild currency rate sources from dry-run hints
      const backend = getBackend();
      if (!reprocessTarget) {
        // "Reprocess All" — safe to clear non-user entries and rebuild
        await backend.clearNonUserRateSources();
      }
      if (reprocessPreview!.currencyHints) {
        for (const [currency, hint] of Object.entries(reprocessPreview!.currencyHints)) {
          const rateSource = hint.source ?? "none";
          await backend.setCurrencyRateSource(currency, rateSource, `handler:${hint.handler}`);
        }
      }

      reprocessApplyResult = combined;
      reprocessPreview = null;

      if (combined.errors.length > 0) {
        toast.warning(`Reprocessed ${combined.changed} transaction(s) with ${combined.errors.length} error(s)`);
      } else {
        toast.success(`Reprocessed ${combined.changed} transaction(s)`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      applyingReprocess = false;
    }
  }

  function formatHash(hash: string): string {
    if (hash.length > 14) return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
    return hash;
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
                      disabled={syncingKey !== null || syncingAll || reprocessing || applyingReprocess}
                    >
                      <RefreshCw class="mr-1 h-3 w-3" />
                      {syncingKey === key ? "Syncing..." : "Sync"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => handleReprocessOne(account)}
                      disabled={syncingKey !== null || syncingAll || reprocessing || applyingReprocess}
                    >
                      <RotateCw class="mr-1 h-3 w-3" />
                      {reprocessing && reprocessTarget?.address === account.address && reprocessTarget?.chainId === account.chain_id ? "Scanning..." : "Reprocess"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => handleRemoveEthAccount(account)}
                      disabled={syncingKey !== null || syncingAll || reprocessing || applyingReprocess}
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
      <div class="flex gap-2">
        <Button
          variant="outline"
          onclick={handleReprocessAll}
          disabled={syncingAll || syncingKey !== null || reprocessing || applyingReprocess || ethAccounts.length === 0}
        >
          <RotateCw class="mr-1 h-4 w-4" />
          {reprocessing && !reprocessTarget ? "Scanning..." : "Reprocess All"}
        </Button>
        <Button
          onclick={handleSyncAll}
          disabled={syncingAll || syncingKey !== null || reprocessing || applyingReprocess || ethAccounts.length === 0 || !settings.etherscanApiKey}
        >
          <RefreshCw class="mr-1 h-4 w-4" />
          {syncingAll ? "Syncing All..." : "Sync All"}
        </Button>
      </div>
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

  <!-- Reprocess Preview -->
  {#if reprocessPreview && reprocessPreview.changed > 0}
    <Card.Root class="border-blue-200 dark:border-blue-800">
      <Card.Header>
        <Card.Title>Reprocess Preview</Card.Title>
        <Card.Description>
          {reprocessPreview.changed} of {reprocessPreview.total} transaction(s) would change.
          {reprocessPreview.unchanged} unchanged, {reprocessPreview.skipped} skipped.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3">
        {#if reprocessPreview.changes.length > 0}
          <div class="max-h-64 overflow-y-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Tx Hash</Table.Head>
                  <Table.Head>Old Handler</Table.Head>
                  <Table.Head>New Handler</Table.Head>
                  <Table.Head>Old Description</Table.Head>
                  <Table.Head>New Description</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each reprocessPreview.changes as change}
                  <Table.Row>
                    <Table.Cell class="font-mono text-xs">{formatHash(change.hash)}</Table.Cell>
                    <Table.Cell><Badge variant="secondary">{change.oldHandler}</Badge></Table.Cell>
                    <Table.Cell><Badge variant="default">{change.newHandler}</Badge></Table.Cell>
                    <Table.Cell class="text-xs max-w-48 truncate">{change.oldDescription}</Table.Cell>
                    <Table.Cell class="text-xs max-w-48 truncate">{change.newDescription}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}

        {#if reprocessPreview.errors.length > 0}
          <div>
            <p class="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Errors ({reprocessPreview.errors.length})
            </p>
            <ul class="mt-1 max-h-32 overflow-y-auto text-xs text-muted-foreground">
              {#each reprocessPreview.errors as error}
                <li class="py-0.5">{error}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if applyingReprocess}
          <div>
            <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                class="h-full bg-primary transition-all duration-300"
                style="width: {reprocessProgress.total > 0 ? (reprocessProgress.processed / reprocessProgress.total * 100) : 0}%"
              ></div>
            </div>
            <p class="text-xs text-muted-foreground mt-1">
              {reprocessProgress.processed} / {reprocessProgress.total}
            </p>
          </div>
        {/if}
      </Card.Content>
      <Card.Footer class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { reprocessPreview = null; reprocessTarget = null; }}>
          Cancel
        </Button>
        <Button onclick={handleApplyReprocess} disabled={applyingReprocess}>
          {applyingReprocess ? "Applying..." : `Apply ${reprocessPreview.changed} Change(s)`}
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}

  <!-- Reprocess Apply Results -->
  {#if reprocessApplyResult}
    <Card.Root class="border-green-200 dark:border-green-800">
      <Card.Header>
        <Card.Title>Reprocess Results</Card.Title>
      </Card.Header>
      <Card.Content class="space-y-3">
        <div class="grid grid-cols-2 gap-4">
          <div class="text-center">
            <p class="text-2xl font-bold">{reprocessApplyResult.changed}</p>
            <p class="text-xs text-muted-foreground">Reprocessed</p>
          </div>
          {#if reprocessApplyResult.errors.length > 0}
            <div class="text-center">
              <p class="text-2xl font-bold text-yellow-600">{reprocessApplyResult.errors.length}</p>
              <p class="text-xs text-muted-foreground">Errors</p>
            </div>
          {/if}
        </div>

        {#if reprocessApplyResult.errors.length > 0}
          <ul class="mt-2 max-h-40 overflow-y-auto text-xs text-muted-foreground">
            {#each reprocessApplyResult.errors as error}
              <li class="py-0.5">{error}</li>
            {/each}
          </ul>
        {/if}

        <div class="mt-4 flex gap-2">
          <Button variant="outline" size="sm" href="/journal">View Journal</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- Transaction Handlers -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Transaction Handlers</Card.Title>
      <Card.Description>Enable protocol-specific handlers for richer transaction interpretation.</Card.Description>
    </Card.Header>
    <Card.Content>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Handler</Table.Head>
            <Table.Head>Description</Table.Head>
            <Table.Head>Chains</Table.Head>
            <Table.Head class="text-right">Enabled</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each handlers as handler}
            {@const isGeneric = handler.id === "generic-etherscan"}
            {@const isEnabled = isGeneric || settings.settings.handlers[handler.id]?.enabled}
            <Table.Row>
              <Table.Cell class="font-medium">{handler.name}</Table.Cell>
              <Table.Cell class="text-muted-foreground">{handler.description}</Table.Cell>
              <Table.Cell>
                {#if handler.supportedChainIds.length === 0}
                  <Badge variant="secondary">All chains</Badge>
                {:else}
                  <div class="flex flex-wrap gap-1">
                    {#each handler.supportedChainIds as chainId}
                      <Badge variant="secondary">{getChainName(chainId)}</Badge>
                    {/each}
                  </div>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if isGeneric}
                  <span class="text-sm text-muted-foreground">Always enabled</span>
                {:else}
                  <Button
                    variant={isEnabled ? "default" : "outline"}
                    size="sm"
                    onclick={() => {
                      const current = { ...settings.settings.handlers };
                      current[handler.id] = { enabled: !isEnabled };
                      settings.update({ handlers: current });
                    }}
                  >
                    {isEnabled ? "On" : "Off"}
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>

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
