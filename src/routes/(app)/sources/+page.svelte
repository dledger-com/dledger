<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getHiddenCurrencySet, markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";

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
  import Pencil from "lucide-svelte/icons/pencil";
  import {
    syncExchangeRates,
    fetchSingleRate,
  } from "$lib/exchange-rate-sync.js";
  import {
    findMissingRates,
    fetchHistoricalRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import type {
    LedgerImportResult,
    ChainInfo,
    EtherscanAccount,
  } from "$lib/types/index.js";
  import { SUPPORTED_CHAINS } from "$lib/types/index.js";
  import {
    getDefaultRegistry,
    dryRunReprocess,
    type ReprocessResult,
  } from "$lib/handlers/index.js";
  import { reprocessStore } from "$lib/data/reprocess-store.svelte.js";
  import RotateCw from "lucide-svelte/icons/rotate-cw";
  import { v7 as uuidv7 } from "uuid";
  import type { ExchangeAccount } from "$lib/cex/types.js";
  import { getCexAdapter, syncCexAccount, retroactiveConsolidate } from "$lib/cex/index.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import Link2 from "lucide-svelte/icons/link-2";
  import CsvImportDialog from "$lib/components/CsvImportDialog.svelte";

  let csvDialogOpen = $state(false);
  let csvInitialContent = $state("");
  let csvInitialFileName = $state("");
  let dragCounter = $state(0);
  let draggingCsv = $derived(dragCounter > 0);

  // Clear initial content when dialog closes
  $effect(() => {
    if (!csvDialogOpen) {
      csvInitialContent = "";
      csvInitialFileName = "";
    }
  });

  function handleCsvDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      csvInitialContent = reader.result as string;
      csvInitialFileName = file.name;
      csvDialogOpen = true;
    };
    reader.readAsText(file);
  }

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
  const ethBusy = $derived(taskQueue.isActive("etherscan-sync"));

  // -- Inline edit state --
  let editingAddress = $state<string | null>(null);
  let editLabel = $state("");
  let editChainIds = $state<Set<number>>(new Set());
  let editChainPopoverOpen = $state(false);
  let savingEdit = $state(false);
  let editError = $state<string | null>(null);

  // Group ethAccounts by address
  interface GroupedAddress {
    address: string;
    label: string;
    chainIds: number[];
  }

  const groupedAddresses = $derived.by(() => {
    const map = new Map<string, GroupedAddress>();
    for (const acc of ethAccounts) {
      const existing = map.get(acc.address);
      if (existing) {
        existing.chainIds.push(acc.chain_id);
      } else {
        map.set(acc.address, { address: acc.address, label: acc.label, chainIds: [acc.chain_id] });
      }
    }
    for (const g of map.values()) g.chainIds.sort((a, b) => a - b);
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  // -- Post-import missing rate backfill state --
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);
  const fetchingMissingRates = $derived(taskQueue.isActive("rate-backfill:missing"));

  // -- Exchange rate sync state --
  const syncingRates = $derived(taskQueue.isActive("rate-sync"));

  // -- Handler change suggestion state --
  let reprocessSuggested = $state(false);

  function suggestReprocess() {
    if (reprocessSuggested) return;
    reprocessSuggested = true;
    toast.info("Handler config changed — reprocess existing transactions to apply new handlers.", {
      action: {
        label: "Reprocess All",
        onClick: () => handleReprocessAll(),
      },
    });
  }

  // -- Reprocess state --
  const reprocessing = $derived(taskQueue.isActive("reprocess-dryrun"));
  const applyingReprocess = $derived(taskQueue.isActive("reprocess-apply"));

  // -- Historical backfill state --
  let backfillCurrencies = $state<string[]>([]);
  let backfillFromDate = $state("");
  let backfillToDate = $state(new Date().toISOString().slice(0, 10));
  const backfilling = $derived(taskQueue.isActive("rate-backfill"));
  let availableCurrencies = $state<string[]>([]);

  // -- CEX state --
  let cexAccounts = $state<ExchangeAccount[]>([]);
  let cexNewExchange = $state<import("$lib/cex/types.js").ExchangeId>("kraken");
  let cexNewLabel = $state("");
  let cexNewApiKey = $state("");
  let cexNewApiSecret = $state("");
  let cexNewPassphrase = $state("");
  let cexAdding = $state(false);
  const cexBusy = $derived(taskQueue.isActive("cex-sync"));
  const cexConsolidating = $derived(taskQueue.isActive("cex-consolidate"));

  async function loadCexAccounts() {
    try {
      cexAccounts = await getBackend().listExchangeAccounts();
    } catch (err) {
      toast.error(`Failed to load exchange accounts: ${err}`);
    }
  }

  async function addCexAccount() {
    if (!cexNewLabel || !cexNewApiKey || !cexNewApiSecret) {
      toast.error("Label, API Key, and API Secret are required");
      return;
    }
    cexAdding = true;
    try {
      const account: ExchangeAccount = {
        id: uuidv7(),
        exchange: cexNewExchange,
        label: cexNewLabel,
        api_key: cexNewApiKey,
        api_secret: cexNewApiSecret,
        passphrase: cexNewPassphrase || null,
        last_sync: null,
        created_at: new Date().toISOString(),
      };
      await getBackend().addExchangeAccount(account);
      cexNewLabel = "";
      cexNewApiKey = "";
      cexNewApiSecret = "";
      cexNewPassphrase = "";
      await loadCexAccounts();
      toast.success("Exchange account added");
    } catch (err) {
      toast.error(`Failed to add exchange account: ${err}`);
    } finally {
      cexAdding = false;
    }
  }

  async function removeCexAccount(id: string) {
    try {
      await getBackend().removeExchangeAccount(id);
      await loadCexAccounts();
      toast.success("Exchange account removed");
    } catch (err) {
      toast.error(`Failed to remove exchange account: ${err}`);
    }
  }

  function syncCex(account: ExchangeAccount) {
    const adapter = getCexAdapter(account.exchange);
    taskQueue.enqueue({
      key: `cex-sync:${account.id}`,
      label: `Sync ${account.label} (${adapter.exchangeName})`,
      async run(ctx) {
        const result = await syncCexAccount(getBackend(), adapter, account, handlerRegistry, {
          signal: ctx.signal,
          onProgress: ctx.reportProgress,
        });
        await loadCexAccounts();
        // Auto-trigger consolidation if entries were imported and etherscan accounts exist
        if (result.entries_imported > 0 && ethAccounts.length > 0) {
          handleConsolidateCex();
        }
        return {
          summary: `${result.entries_imported} imported, ${result.entries_skipped} skipped, ${result.entries_consolidated} consolidated`,
        };
      },
    });
  }

  function syncAllCex() {
    for (const account of cexAccounts) {
      syncCex(account);
    }
  }

  function handleConsolidateCex() {
    taskQueue.enqueue({
      key: "cex-consolidate",
      label: "Consolidate CEX ↔ Etherscan entries",
      async run(ctx) {
        const result = await retroactiveConsolidate(getBackend(), handlerRegistry, {
          signal: ctx.signal,
          onProgress: ctx.reportProgress,
        });
        if (result.pairs_found === 0) {
          return { summary: "No matching pairs found" };
        }
        return {
          summary: `${result.pairs_consolidated} consolidated, ${result.pairs_skipped} skipped of ${result.pairs_found} pairs`,
        };
      },
    });
  }

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

  function handleBackfill() {
    if (backfillCurrencies.length === 0 || !backfillFromDate || !backfillToDate) {
      toast.error("Select currencies and date range");
      return;
    }

    const currencies = [...backfillCurrencies];
    const from = backfillFromDate;
    const to = backfillToDate;

    taskQueue.enqueue({
      key: "rate-backfill",
      label: `Backfill rates (${currencies.length} currencies)`,
      async run(ctx) {
        // Generate date targets for each currency
        const currencyDates: { currency: string; date: string }[] = [];
        for (const currency of currencies) {
          let current = new Date(from);
          const end = new Date(to);
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
          return { summary: "All rates already available" };
        }

        const result = await fetchHistoricalRates(
          getBackend(),
          missing,
          {
            baseCurrency: settings.currency,
            coingeckoApiKey: settings.coingeckoApiKey,
            finnhubApiKey: settings.finnhubApiKey,
            cryptoCompareApiKey: settings.cryptoCompareApiKey,
            onProgress: (fetched, total) => {
              ctx.reportProgress({ current: fetched, total });
            },
          },
        );

        // Auto-hide currencies that failed all sources
        if (result.failedCurrencies.length > 0) {
          const backend = getBackend();
          for (const code of result.failedCurrencies) {
            await backend.setCurrencyRateSource(code, "none", "auto");
            await markCurrencyHidden(backend, code);
          }
          showAutoHideToast(result.failedCurrencies);
          loadAvailableCurrencies();
        }

        if (result.errors.length > 0) {
          toast.warning(`Fetched ${result.fetched} rate(s) with ${result.errors.length} warning(s)`);
        } else {
          toast.success(`Fetched ${result.fetched} historical rate(s)`);
        }

        return { summary: `Fetched ${result.fetched} rate(s)`, data: result };
      },
    });
  }

  function handleSyncRates() {
    taskQueue.enqueue({
      key: "rate-sync",
      label: "Sync exchange rates",
      async run() {
        const backend = getBackend();
        const r = await syncExchangeRates(
          backend,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          getHiddenCurrencySet(),
          settings.cryptoCompareApiKey,
        );

        settings.update({ lastRateSync: new Date().toISOString().slice(0, 10) });

        if (r.autoHidden.length > 0) {
          for (const code of r.autoHidden) {
            await markCurrencyHidden(backend, code);
          }
          showAutoHideToast(r.autoHidden);
          loadAvailableCurrencies();
        }

        if (r.errors.length > 0) {
          toast.warning(`Synced ${r.rates_fetched} rate(s) with ${r.errors.length} warning(s)`);
        } else {
          toast.success(`Synced ${r.rates_fetched} exchange rate(s)`);
        }

        return { summary: `${r.rates_fetched} rate(s) synced`, data: r };
      },
    });
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
    loadCexAccounts();
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

  function handleFetchMissingRates() {
    const requests = [...missingRateRequests];
    taskQueue.enqueue({
      key: "rate-backfill:missing",
      label: `Fetch ${requests.reduce((sum, r) => sum + r.dates.length, 0)} missing rate(s)`,
      async run(ctx) {
        const result = await fetchHistoricalRates(
          getBackend(),
          requests,
          {
            baseCurrency: settings.currency,
            coingeckoApiKey: settings.coingeckoApiKey,
            finnhubApiKey: settings.finnhubApiKey,
            cryptoCompareApiKey: settings.cryptoCompareApiKey,
            onProgress: (fetched, total) => {
              ctx.reportProgress({ current: fetched, total });
            },
          },
        );
        missingRateRequests = [];

        // Auto-hide currencies that failed all sources
        if (result.failedCurrencies.length > 0) {
          const backend = getBackend();
          for (const code of result.failedCurrencies) {
            await backend.setCurrencyRateSource(code, "none", "auto");
            await markCurrencyHidden(backend, code);
          }
          showAutoHideToast(result.failedCurrencies);
          loadAvailableCurrencies();
        }

        if (result.errors.length > 0) {
          toast.warning(`Fetched ${result.fetched} rate(s) with ${result.errors.length} warning(s)`);
        } else {
          toast.success(`Fetched ${result.fetched} historical rate(s)`);
        }

        return { summary: `Fetched ${result.fetched} rate(s)`, data: result };
      },
    });
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

  function syncEthAccount(account: EtherscanAccount) {
    const apiKey = settings.etherscanApiKey;
    if (!apiKey) {
      toast.error("Etherscan API key is required");
      return;
    }
    taskQueue.enqueue({
      key: `etherscan-sync:${account.address}:${account.chain_id}`,
      label: `Sync ${account.label} (${getChainName(account.chain_id)})`,
      async run() {
        const r = await getBackend().syncEtherscan(
          apiKey,
          account.address,
          account.label,
          account.chain_id,
        );
        await loadEthAccounts();
        // Auto-trigger consolidation if entries were imported and CEX accounts exist
        if (r.transactions_imported > 0 && cexAccounts.length > 0) {
          handleConsolidateCex();
        }
        return {
          summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`,
          data: r,
        };
      },
    });
  }

  function handleSyncAll() {
    const apiKey = settings.etherscanApiKey;
    if (!apiKey) {
      toast.error("Etherscan API key is required");
      return;
    }
    if (ethAccounts.length === 0) {
      toast.error("No tracked addresses to sync");
      return;
    }
    for (const account of ethAccounts) {
      syncEthAccount(account);
    }
  }

  function handleReprocessOne(account: EtherscanAccount) {
    taskQueue.enqueue({
      key: `reprocess-dryrun:${account.address}:${account.chain_id}`,
      label: `Reprocess scan ${account.label} (${getChainName(account.chain_id)})`,
      async run(ctx) {
        const r = await dryRunReprocess(getBackend(), handlerRegistry, {
          chainId: account.chain_id,
          address: account.address,
          label: account.label,
          settings: settings.settings,
          onProgress: (processed, total) => ctx.reportProgress({ current: processed, total }),
        });
        if (r.total === 0) {
          toast.info("No raw transaction data found — re-sync first");
          return { summary: "No raw data found" };
        }
        if (r.changed === 0) {
          toast.success("All transactions unchanged");
          return { summary: `${r.total} scanned, 0 changed` };
        }
        return {
          summary: `${r.changed} of ${r.total} would change`,
          data: { result: r, target: { chainId: account.chain_id, address: account.address, label: account.label } },
          actionRequired: true,
          actionLabel: `Review ${r.changed} Change(s)`,
        };
      },
      onAction(task) {
        const d = task.result?.data as { result: ReprocessResult; target: { chainId: number; address: string; label: string } } | undefined;
        if (d) {
          reprocessStore.show(d.result, d.target);
        }
        taskQueue.dismiss(task.id);
      },
    });
  }

  function handleReprocessAll() {
    if (ethAccounts.length === 0) return;
    const accounts = [...ethAccounts];
    taskQueue.enqueue({
      key: "reprocess-dryrun:all",
      label: `Reprocess scan (${accounts.length} accounts)`,
      async run(ctx) {
        const combined: ReprocessResult = {
          total: 0,
          unchanged: 0,
          changed: 0,
          skipped: 0,
          errors: [],
          changes: [],
          currencyHints: {},
        };
        let processedSoFar = 0;
        for (const account of accounts) {
          const r = await dryRunReprocess(getBackend(), handlerRegistry, {
            chainId: account.chain_id,
            address: account.address,
            label: account.label,
            settings: settings.settings,
            onProgress: (processed, total) => {
              ctx.reportProgress({ current: processedSoFar + processed, total: processedSoFar + total });
            },
          });
          processedSoFar += r.total;
          combined.total += r.total;
          combined.unchanged += r.unchanged;
          combined.changed += r.changed;
          combined.skipped += r.skipped;
          combined.errors.push(...r.errors);
          combined.changes.push(...r.changes);
          combined.currencyHints = { ...combined.currencyHints, ...r.currencyHints };
        }
        if (combined.total === 0) {
          toast.info("No raw transaction data found — re-sync your accounts first");
          return { summary: "No raw data found" };
        }
        if (combined.changed === 0) {
          toast.success("All transactions unchanged");
          return { summary: `${combined.total} scanned, 0 changed` };
        }
        return {
          summary: `${combined.changed} of ${combined.total} would change`,
          data: { result: combined, target: null },
          actionRequired: true,
          actionLabel: `Review ${combined.changed} Change(s)`,
        };
      },
      onAction(task) {
        const d = task.result?.data as { result: ReprocessResult; target: null } | undefined;
        if (d) {
          reprocessStore.show(d.result, null);
        }
        taskQueue.dismiss(task.id);
      },
    });
  }

  // -- Inline edit handlers --
  function startEditAddress(group: GroupedAddress) {
    editingAddress = group.address;
    editLabel = group.label;
    editChainIds = new Set(group.chainIds);
    editError = null;
  }

  function cancelEdit() {
    editingAddress = null;
    editLabel = "";
    editChainIds = new Set();
    editError = null;
  }

  function toggleEditChain(chainId: number) {
    const next = new Set(editChainIds);
    if (next.has(chainId)) {
      next.delete(chainId);
    } else {
      next.add(chainId);
    }
    editChainIds = next;
  }

  async function saveEdit() {
    if (!editingAddress) return;
    const label = editLabel.trim();
    if (!label) {
      editError = "Label is required";
      return;
    }
    if (editChainIds.size === 0) {
      editError = "At least one chain is required";
      return;
    }

    savingEdit = true;
    editError = null;
    const address = editingAddress;

    try {
      const backend = getBackend();
      // Find current chains for this address
      const currentChains = new Set(
        ethAccounts
          .filter((a) => a.address === address)
          .map((a) => a.chain_id)
      );

      // Remove chains that were deselected
      for (const chainId of currentChains) {
        if (!editChainIds.has(chainId)) {
          await backend.removeEtherscanAccount(address, chainId);
        }
      }

      // Upsert all desired chains (propagates label to all)
      for (const chainId of editChainIds) {
        await backend.addEtherscanAccount(address, chainId, label);
      }

      await loadEthAccounts();
      cancelEdit();
      toast.success("Address updated");
    } catch (err) {
      toast.error(String(err));
    } finally {
      savingEdit = false;
    }
  }

  function handleSyncGroup(group: GroupedAddress) {
    for (const chainId of group.chainIds) {
      syncEthAccount({ address: group.address, chain_id: chainId, label: group.label });
    }
  }

  function handleReprocessGroup(group: GroupedAddress) {
    for (const chainId of group.chainIds) {
      handleReprocessOne({ address: group.address, chain_id: chainId, label: group.label });
    }
  }

  async function handleRemoveGroup(group: GroupedAddress) {
    try {
      const backend = getBackend();
      for (const chainId of group.chainIds) {
        await backend.removeEtherscanAccount(group.address, chainId);
      }
      await loadEthAccounts();
      toast.success("Address removed");
    } catch (err) {
      toast.error(String(err));
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
      <div class="flex gap-2">
        <Button variant="outline" href="/journal">Cancel</Button>
        <Button variant="outline" onclick={() => { csvDialogOpen = true; }}>Import CSV</Button>
      </div>
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
      </Card.Content>
      <Card.Footer class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => { missingRateRequests = []; }}>Skip</Button>
        <Button onclick={handleFetchMissingRates} disabled={fetchingMissingRates}>
          {fetchingMissingRates ? "Fetching..." : "Fetch Now"}
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}

  <!-- CSV Import -->
  <Card.Root
    class={draggingCsv ? "outline-2 outline-dashed outline-primary -outline-offset-2 bg-accent/50 transition-colors" : "transition-colors"}
    ondragenter={(e: DragEvent) => { e.preventDefault(); dragCounter++; }}
    ondragover={(e: DragEvent) => { e.preventDefault(); }}
    ondragleave={() => { dragCounter--; }}
    ondrop={handleCsvDrop}
  >
    <Card.Header>
      <Card.Title>CSV Import</Card.Title>
      <Card.Description>Import transactions from CSV files — bank statements, exchange exports, and more.</Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="flex items-center gap-3">
        <Button onclick={() => { csvDialogOpen = true; }}>
          <Upload class="mr-2 h-4 w-4" /> Import CSV
        </Button>
        {#if draggingCsv}
          <p class="text-sm text-muted-foreground">Drop CSV file to import...</p>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>

  <CsvImportDialog
    bind:open={csvDialogOpen}
    initialContent={csvInitialContent}
    initialFileName={csvInitialFileName}
  />

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
          >. One key works for most chains. BSC, Base, OP, and Avalanche use Routescan (configured below).
        </p>
      </div>

      <!-- Routescan API Key -->
      <div class="space-y-2">
        <label for="routescan-api-key" class="text-sm font-medium">Routescan API Key (optional)</label>
        <Input
          id="routescan-api-key"
          type="password"
          placeholder="Routescan API key"
          value={settings.settings.routescanApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ routescanApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Used for BSC, Base, Optimism, and Avalanche (free at <a
            href="https://routescan.io"
            target="_blank"
            class="underline hover:text-foreground">routescan.io</a
          >). Leave blank for keyless access (slower rate limit).
        </p>
      </div>

      <!-- Tracked Addresses Table -->
      {#if groupedAddresses.length > 0}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Address</Table.Head>
              <Table.Head>Label</Table.Head>
              <Table.Head>Chains</Table.Head>
              <Table.Head class="text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each groupedAddresses as group}
              {#if editingAddress === group.address}
                <!-- Edit mode -->
                <Table.Row>
                  <Table.Cell colspan={4}>
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                      class="space-y-3 py-2"
                      role="form"
                      onkeydown={(e: KeyboardEvent) => { if (e.key === "Escape") cancelEdit(); }}
                    >
                      <div class="flex items-center gap-3">
                        <span class="font-mono text-sm text-muted-foreground">{formatAddress(group.address)}</span>
                        <div class="flex-1">
                          <Input
                            placeholder="Label"
                            bind:value={editLabel}
                          />
                        </div>
                      </div>

                      <!-- Chain multi-select -->
                      <div class="space-y-2">
                        <span class="text-xs font-medium">Chains</span>
                        <Popover.Root bind:open={editChainPopoverOpen}>
                          <Popover.Trigger>
                            <Button variant="outline" class="w-[300px] justify-between">
                              {#if editChainIds.size === 0}
                                Select chains...
                              {:else}
                                {editChainIds.size} chain{editChainIds.size === 1 ? "" : "s"} selected
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
                                      onSelect={() => toggleEditChain(chain.chain_id)}
                                    >
                                      <Check
                                        class={cn(
                                          "mr-2 h-4 w-4",
                                          editChainIds.has(chain.chain_id) ? "opacity-100" : "opacity-0"
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

                        {#if editChainIds.size > 0}
                          <div class="flex flex-wrap gap-1">
                            {#each SUPPORTED_CHAINS.filter((c) => editChainIds.has(c.chain_id)) as chain}
                              <Badge variant="secondary" class="gap-1">
                                {chain.name}
                                <button onclick={() => toggleEditChain(chain.chain_id)} class="ml-0.5 rounded-full outline-none hover:bg-muted">
                                  <X class="h-3 w-3" />
                                </button>
                              </Badge>
                            {/each}
                          </div>
                        {/if}
                      </div>

                      {#if editError}
                        <p class="text-sm text-destructive">{editError}</p>
                      {/if}

                      <div class="flex gap-2">
                        <Button size="sm" onclick={saveEdit} disabled={savingEdit}>
                          {savingEdit ? "Saving..." : "Save"}
                        </Button>
                        <Button variant="outline" size="sm" onclick={cancelEdit} disabled={savingEdit}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </Table.Cell>
                </Table.Row>
              {:else}
                <!-- Display mode -->
                {@const isSyncingGroup = taskQueue.isActive(`etherscan-sync:${group.address}`)}
                <Table.Row>
                  <Table.Cell class="font-mono text-sm">{formatAddress(group.address)}</Table.Cell>
                  <Table.Cell>{group.label}</Table.Cell>
                  <Table.Cell>
                    <div class="flex flex-wrap gap-1">
                      {#each group.chainIds as chainId}
                        <Badge variant="secondary">{getChainName(chainId)}</Badge>
                      {/each}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-right">
                    <div class="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => handleSyncGroup(group)}
                        disabled={ethBusy || reprocessing || applyingReprocess}
                      >
                        <RefreshCw class="mr-1 h-3 w-3" />
                        {isSyncingGroup ? "Syncing..." : "Sync"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => handleReprocessGroup(group)}
                        disabled={ethBusy || reprocessing || applyingReprocess}
                      >
                        <RotateCw class="mr-1 h-3 w-3" />
                        Reprocess
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => startEditAddress(group)}
                        disabled={ethBusy || reprocessing || applyingReprocess}
                      >
                        <Pencil class="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => handleRemoveGroup(group)}
                        disabled={ethBusy || reprocessing || applyingReprocess}
                      >
                        <Trash2 class="h-3 w-3" />
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              {/if}
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
          disabled={ethBusy || reprocessing || applyingReprocess || ethAccounts.length === 0}
        >
          <RotateCw class="mr-1 h-4 w-4" />
          {taskQueue.isActive("reprocess-dryrun:all") ? "Scanning..." : "Reprocess All"}
        </Button>
        <Button
          onclick={handleSyncAll}
          disabled={ethBusy || reprocessing || applyingReprocess || ethAccounts.length === 0 || !settings.etherscanApiKey}
        >
          <RefreshCw class="mr-1 h-4 w-4" />
          {ethBusy ? "Syncing All..." : "Sync All"}
        </Button>
      </div>
    </Card.Footer>
  </Card.Root>

  <!-- Centralized Exchanges -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Centralized Exchanges</Card.Title>
      <Card.Description>Import trade history, deposits, and withdrawals from centralized exchanges.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if cexAccounts.length > 0}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Exchange</Table.Head>
              <Table.Head>Label</Table.Head>
              <Table.Head class="hidden sm:table-cell">Last Sync</Table.Head>
              <Table.Head class="text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each cexAccounts as account}
              <Table.Row>
                <Table.Cell>
                  <Badge variant="secondary">{account.exchange}</Badge>
                </Table.Cell>
                <Table.Cell class="font-medium">{account.label}</Table.Cell>
                <Table.Cell class="hidden sm:table-cell">
                  {#if account.last_sync}
                    <span class="text-xs text-muted-foreground">{new Date(account.last_sync).toLocaleDateString()}</span>
                  {:else}
                    <span class="text-xs text-muted-foreground">Never</span>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={cexBusy}
                      onclick={() => syncCex(account)}
                    >
                      <RefreshCw class="h-4 w-4 {taskQueue.queue.some((t) => t.key === `cex-sync:${account.id}` && t.status === 'running') ? 'animate-spin' : ''}" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => removeCexAccount(account.id)}
                    >
                      <Trash2 class="h-4 w-4" />
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}

      <!-- Add exchange form -->
      <div class="space-y-3 rounded-lg border p-4">
        <h4 class="text-sm font-medium">Add Exchange Account</h4>
        <div class="flex flex-wrap gap-2">
          <div class="w-full sm:w-auto">
            <select
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-40"
              bind:value={cexNewExchange}
            >
              <option value="kraken">Kraken</option>
              <option value="binance">Binance</option>
              <option value="coinbase">Coinbase</option>
              <option value="bybit">Bybit</option>
              <option value="okx">OKX</option>
              <option value="bitstamp">Bitstamp</option>
              <option value="cryptocom">Crypto.com</option>
            </select>
          </div>
          <Input
            class="w-full sm:w-40"
            placeholder="Label (e.g., Main)"
            bind:value={cexNewLabel}
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <Input
            class="w-full sm:flex-1"
            type="password"
            placeholder={cexNewExchange === "coinbase" ? "API Key Name" : "API Key"}
            bind:value={cexNewApiKey}
          />
          <Input
            class="w-full sm:flex-1"
            type="password"
            placeholder={cexNewExchange === "coinbase" ? "EC Private Key (PEM)" : "API Secret"}
            bind:value={cexNewApiSecret}
          />
        </div>
        {#if getCexAdapter(cexNewExchange).requiresPassphrase}
          <Input
            class="w-full sm:w-64"
            type="password"
            placeholder="API Passphrase"
            bind:value={cexNewPassphrase}
          />
        {/if}
        <Button size="sm" disabled={cexAdding} onclick={addCexAccount}>
          <Plus class="mr-1 h-4 w-4" />
          Add Account
        </Button>
      </div>

      {#if cexAccounts.length > 0}
        <div class="flex justify-end gap-2">
          {#if ethAccounts.length > 0}
            <Button
              variant="outline"
              size="sm"
              disabled={cexBusy || cexConsolidating}
              onclick={handleConsolidateCex}
            >
              <Link2 class="mr-1 h-4 w-4" />
              {cexConsolidating ? "Consolidating..." : "Consolidate"}
            </Button>
          {/if}
          {#if cexAccounts.length > 1}
            <Button
              variant="outline"
              size="sm"
              disabled={cexBusy}
              onclick={syncAllCex}
            >
              <RefreshCw class="mr-1 h-4 w-4 {cexBusy ? 'animate-spin' : ''}" />
              Sync All
            </Button>
          {/if}
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

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
            <Table.Head class="hidden md:table-cell">Description</Table.Head>
            <Table.Head class="hidden lg:table-cell">Chains</Table.Head>
            <Table.Head class="text-right hidden sm:table-cell">Enrichment</Table.Head>
            <Table.Head class="text-right">Enabled</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each handlers as handler}
            {@const isGeneric = handler.id === "generic-etherscan"}
            {@const isEnabled = isGeneric || settings.settings.handlers[handler.id]?.enabled}
            <Table.Row>
              <Table.Cell class="font-medium">{handler.name}</Table.Cell>
              <Table.Cell class="text-muted-foreground hidden md:table-cell">{handler.description}</Table.Cell>
              <Table.Cell class="hidden lg:table-cell">
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
              {@const hasEnrichment = ["uniswap", "aave", "lido", "curve", "pendle", "compound", "yearn", "balancer", "maker"].includes(handler.id)}
              {@const enrichmentEnabled = settings.settings.handlers[handler.id]?.enrichment ?? false}
              <Table.Cell class="text-right hidden sm:table-cell">
                {#if hasEnrichment && !isGeneric}
                  <Switch
                    checked={enrichmentEnabled}
                    disabled={!isEnabled}
                    onCheckedChange={(v) => {
                      const current = { ...settings.settings.handlers };
                      const prev = current[handler.id] ?? { enabled: false };
                      current[handler.id] = { ...prev, enrichment: v };
                      settings.update({ handlers: current });
                      suggestReprocess();
                    }}
                  />
                {:else}
                  <span class="text-sm text-muted-foreground">--</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                {#if isGeneric}
                  <span class="text-sm text-muted-foreground">Always enabled</span>
                {:else}
                  <Switch
                    checked={isEnabled ?? false}
                    onCheckedChange={(v) => {
                      const current = { ...settings.settings.handlers };
                      current[handler.id] = { ...current[handler.id], enabled: v };
                      settings.update({ handlers: current });
                      suggestReprocess();
                    }}
                  />
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>

  <!-- External Services -->
  <Card.Root>
    <Card.Header>
      <Card.Title>External Services</Card.Title>
      <Card.Description>API keys for external data providers. Rates: ECB (fiat), DefiLlama/CoinGecko/CryptoCompare/Binance (crypto), Finnhub (stocks). Enrichment: The Graph (Uniswap pools).</Card.Description>
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
        <label for="cryptocompare-api-key" class="text-sm font-medium">CryptoCompare API Key</label>
        <Input
          id="cryptocompare-api-key"
          type="password"
          placeholder="CryptoCompare API key (optional)"
          value={settings.cryptoCompareApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ cryptoCompareApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Get a free key at <a href="https://www.cryptocompare.com/cryptopian/api-keys" target="_blank"
            class="underline hover:text-foreground">cryptocompare.com</a>.
          Optional fallback for crypto historical rates.
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

      <div class="space-y-2">
        <label for="thegraph-api-key" class="text-sm font-medium">The Graph API Key</label>
        <Input
          id="thegraph-api-key"
          type="password"
          placeholder="The Graph API key (optional)"
          value={settings.theGraphApiKey}
          oninput={(e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            settings.update({ theGraphApiKey: val });
          }}
        />
        <p class="text-xs text-muted-foreground">
          Get a free key at <a href="https://thegraph.com/studio/apikeys/" target="_blank"
            class="underline hover:text-foreground">thegraph.com/studio</a>.
          Required for Uniswap pool enrichment.
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

</div>
