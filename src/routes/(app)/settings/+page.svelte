<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend, type CurrencyRateSource } from "$lib/backend.js";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
  import { getHiddenCurrencySet, markCurrencyHidden, unmarkCurrencyHidden, reloadHiddenCurrencies } from "$lib/data/hidden-currencies.svelte.js";
  import type { Currency, ExchangeRate } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import { fetchSingleRate, type SourceName } from "$lib/exchange-rate-sync.js";
  import { exportDatabaseBackup, readFileAsUint8Array, downloadDatabase } from "$lib/utils/database-export.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { createDpriceClient, type DpriceHealthResponse } from "$lib/dprice-client.js";
  import { isDpriceActive, type DpriceMode } from "$lib/data/settings.svelte.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import {
    DEFAULT_PATH_CONFIG,
    PATH_TYPE_CONSTRAINTS,
    getAccountPathConfig,
    validatePathConfig,
    type AccountPathConfig,
  } from "$lib/accounts/paths.js";
  import { createDefaultAccounts, type DefaultAccountSet } from "$lib/accounts/defaults.js";
  const settings = new SettingsStore();

  // Account Paths state
  let pathOverrides = $state<Partial<AccountPathConfig>>(
    settings.settings.accountPaths ? { ...settings.settings.accountPaths } : {},
  );
  let pathRenaming = $state(false);
  let renameCounts = $state<Map<string, number>>(new Map());

  function getPathValue(key: keyof AccountPathConfig): string {
    return pathOverrides[key] ?? DEFAULT_PATH_CONFIG[key];
  }

  function handlePathChange(key: keyof AccountPathConfig, value: string) {
    if (value === DEFAULT_PATH_CONFIG[key]) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _, ...rest } = pathOverrides;
      pathOverrides = rest;
    } else {
      pathOverrides = { ...pathOverrides, [key]: value };
    }
    const errors = validatePathConfig({ [key]: value });
    if (errors.length === 0) {
      settings.update({ accountPaths: Object.keys(pathOverrides).length > 0 ? pathOverrides : undefined });
    }
  }

  function resetPathSection(keys: (keyof AccountPathConfig)[]) {
    const next = { ...pathOverrides };
    for (const k of keys) delete next[k];
    pathOverrides = next;
    settings.update({ accountPaths: Object.keys(pathOverrides).length > 0 ? pathOverrides : undefined });
  }

  async function countAffectedAccounts() {
    try {
      const accounts = await getBackend().listAccounts();
      const counts = new Map<string, number>();
      const saved = settings.settings.accountPaths ?? {};
      for (const [key, defaultVal] of Object.entries(DEFAULT_PATH_CONFIG)) {
        const currentVal = saved[key as keyof AccountPathConfig];
        if (currentVal && currentVal !== defaultVal) {
          // Count accounts under the OLD prefix (the default one) that could be renamed
          const prefix = defaultVal;
          const count = accounts.filter(
            (a) => a.full_name === prefix || a.full_name.startsWith(prefix + ":"),
          ).length;
          if (count > 0) counts.set(key, count);
        }
      }
      renameCounts = counts;
    } catch {
      renameCounts = new Map();
    }
  }

  async function handleRenameAll() {
    pathRenaming = true;
    try {
      const backend = getBackend();
      const saved = settings.settings.accountPaths ?? {};
      let totalRenamed = 0;
      let totalSkipped = 0;
      for (const [key, defaultVal] of Object.entries(DEFAULT_PATH_CONFIG)) {
        const newVal = saved[key as keyof AccountPathConfig];
        if (newVal && newVal !== defaultVal) {
          const result = await backend.renameAccountPrefix(defaultVal, newVal);
          totalRenamed += result.renamed;
          totalSkipped += result.skipped;
        }
      }
      if (totalRenamed > 0) {
        toast.success(`Renamed ${totalRenamed} account${totalRenamed !== 1 ? "s" : ""}${totalSkipped > 0 ? ` (${totalSkipped} skipped)` : ""}`);
      } else {
        toast.info("No accounts needed renaming");
      }
      renameCounts = new Map();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      pathRenaming = false;
    }
  }

  const PATH_SECTIONS: { title: string; description: string; keys: { key: keyof AccountPathConfig; label: string; example: string }[] }[] = [
    {
      title: "Banking",
      description: "Paths for bank account imports (CSV, OFX, PDF).",
      keys: [
        { key: "bankAssets", label: "Bank Assets", example: "MyBank" },
        { key: "bankFees", label: "Bank Fees", example: "MyBank" },
        { key: "creditCards", label: "Credit Cards", example: "1234" },
      ],
    },
    {
      title: "Exchange",
      description: "Paths for crypto exchange imports and CEX integration.",
      keys: [
        { key: "exchangeAssets", label: "Exchange Assets", example: "Kraken" },
        { key: "exchangeFees", label: "Exchange Fees", example: "Kraken" },
        { key: "exchangeEquity", label: "Exchange Equity", example: "Kraken" },
        { key: "exchangeStaking", label: "Exchange Staking", example: "Kraken" },
        { key: "exchangeIncome", label: "Exchange Income", example: "Nexo" },
        { key: "exchangeExpenses", label: "Exchange Expenses", example: "CryptoCom" },
      ],
    },
    {
      title: "Wallet / On-chain",
      description: "Paths for on-chain wallet and gas fee accounts.",
      keys: [
        { key: "walletAssets", label: "Wallet Assets", example: "Ethereum:Main" },
        { key: "walletEquity", label: "Wallet Equity", example: "Ethereum" },
        { key: "chainFees", label: "Chain Fees", example: "Ethereum" },
      ],
    },
    {
      title: "DeFi",
      description: "Paths for DeFi protocol accounts (Aave, Uniswap, etc.).",
      keys: [
        { key: "defiAssets", label: "DeFi Assets", example: "Aave:Supply" },
        { key: "defiLiabilities", label: "DeFi Liabilities", example: "Aave:Borrow" },
        { key: "defiIncome", label: "DeFi Income", example: "Aave:Interest" },
        { key: "defiExpenses", label: "DeFi Expenses", example: "Aave:Interest" },
      ],
    },
  ];

  function pathErrors(key: keyof AccountPathConfig): string | null {
    const value = getPathValue(key);
    const errs = validatePathConfig({ [key]: value });
    return errs.length > 0 ? errs[0].error : null;
  }

  // Backup/restore state
  let exporting = $state(false);
  let importing = $state(false);

  // Currency list from backend
  let currencies = $state<Currency[]>([]);

  // Rate source config from DB
  let rateSources = $state<Map<string, CurrencyRateSource>>(new Map());

  // Currency form
  let currCode = $state("");
  let currName = $state("");
  let currDecimals = $state("2");
  let currIsBase = $state(false);

  // Exchange rate form
  let rateFrom = $state("");
  let rateTo = $state("");
  let rateValue = $state("");
  let rateDate = $state(new Date().toISOString().slice(0, 10));

  // Exchange rates list
  let exchangeRates = $state<ExchangeRate[]>([]);
  let ratesLoading = $state(false);
  let currencySearchTerm = $state("");

  // Sort state for currencies table
  type CurrencySortKey = "code" | "name" | "decimals" | "base" | "rateSource";
  const sortCurr = createSortState<CurrencySortKey>();
  const currencyAccessors: Record<CurrencySortKey, SortAccessor<Currency>> = {
    code: (c) => c.code,
    name: (c) => c.name,
    decimals: (c) => c.decimal_places,
    base: (c) => c.is_base ? 1 : 0,
    rateSource: (c) => rateSources.get(c.code)?.rate_source ?? "auto",
  };

  // Sort state for exchange rates table
  type RateSortKey = "date" | "from" | "to" | "rate" | "source";
  const sortRates = createSortState<RateSortKey>();
  const rateAccessors: Record<RateSortKey, SortAccessor<ExchangeRate>> = {
    date: (r) => r.date,
    from: (r) => r.from_currency,
    to: (r) => r.to_currency,
    rate: (r) => parseFloat(r.rate),
    source: (r) => r.source,
  };

  const dateFormats = [
    { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO)" },
    { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
    { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  ];

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  async function loadCurrencies() {
    try {
      currencies = await getBackend().listCurrencies();
    } catch {
      currencies = [];
    }
  }

  async function loadExchangeRates() {
    ratesLoading = true;
    try {
      exchangeRates = await getBackend().listExchangeRates();
    } catch {
      exchangeRates = [];
    } finally {
      ratesLoading = false;
    }
  }

  async function loadRateSources() {
    try {
      const rows = await getBackend().getCurrencyRateSources();
      rateSources = new Map(rows.map((r) => [r.currency, r]));
    } catch {
      rateSources = new Map();
    }
  }

  async function addCurrency() {
    if (!currCode.trim() || !currName.trim()) {
      toast.error("Code and name are required");
      return;
    }
    try {
      await getBackend().createCurrency({
        code: currCode.trim().toUpperCase(),
        name: currName.trim(),
        decimal_places: parseInt(currDecimals, 10) || 2,
        is_base: currIsBase,
      });
      toast.success(`Currency ${currCode.trim().toUpperCase()} created`);
      currCode = "";
      currName = "";
      currDecimals = "2";
      currIsBase = false;
      await loadCurrencies();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function addExchangeRate() {
    if (!rateFrom.trim() || !rateTo.trim() || !rateValue.trim() || !rateDate) {
      toast.error("All fields are required");
      return;
    }
    try {
      const rate: ExchangeRate = {
        id: uuidv7(),
        date: rateDate,
        from_currency: rateFrom.toUpperCase(),
        to_currency: rateTo.toUpperCase(),
        rate: rateValue,
        source: "manual",
      };
      await getBackend().recordExchangeRate(rate);
      toast.success("Exchange rate recorded");
      rateFrom = "";
      rateTo = "";
      rateValue = "";
      rateDate = new Date().toISOString().slice(0, 10);
      await loadExchangeRates();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function handleCurrencyChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    settings.update({ currency: target.value });
  }

  function handleDateFormatChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    settings.update({ dateFormat: target.value });
  }

  function handleFiscalYearChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const month = parseInt(target.value, 10);
    const mm = String(month).padStart(2, "0");
    settings.update({ fiscalYearStart: `${mm}-01` });
  }

  const clearing = $derived(
    taskQueue.isActive("clear-exchange-rates") ||
    taskQueue.isActive("clear-ledger-data") ||
    taskQueue.isActive("clear-all-data"),
  );

  function handleClearExchangeRates() {
    if (!window.confirm("Are you sure you want to clear all exchange rates? This cannot be undone.")) return;
    taskQueue.enqueue({
      key: "clear-exchange-rates",
      label: "Clear exchange rates",
      async run() {
        await getBackend().clearExchangeRates();
        await getBackend().clearAutoRateSources();
        await loadExchangeRates();
        toast.success("Exchange rates cleared");
        return { summary: "Exchange rates cleared" };
      },
    });
  }

  function handleClearLedgerData() {
    if (!window.confirm("Are you sure you want to clear all ledger data? This will remove all accounts, transactions, and currencies. Exchange rates, sources, and settings will be preserved. This cannot be undone.")) return;
    taskQueue.enqueue({
      key: "clear-ledger-data",
      label: "Clear ledger data",
      async run() {
        await getBackend().clearLedgerData();
        await reloadHiddenCurrencies(getBackend());
        currencies = [];
        toast.success("Ledger data cleared");
        return { summary: "Ledger data cleared" };
      },
    });
  }

  function handleClearAllData() {
    if (!window.confirm("Are you sure you want to delete ALL data? This will remove all accounts, transactions, currencies, exchange rates, and reset settings. This cannot be undone.")) return;
    taskQueue.enqueue({
      key: "clear-all-data",
      label: "Clear all data",
      async run() {
        await getBackend().clearAllData();
        settings.reset();
        currencies = [];
        exchangeRates = [];
        toast.success("All data cleared");
        return { summary: "All data cleared" };
      },
    });
  }

  async function handleSourceChange(currencyCode: string, newSource: string) {
    // Save to DB as user preference
    await getBackend().setCurrencyRateSource(currencyCode, newSource === "auto" ? null : newSource, "user");

    if (newSource === "auto" || newSource === "none") {
      await loadRateSources();
      toast.success(`Updated ${currencyCode} rate source to ${newSource}`);
      return;
    }

    // Refetch rate from new source via task queue
    taskQueue.enqueue({
      key: `rate-refetch:${currencyCode}`,
      label: `Fetch ${currencyCode} rate from ${newSource}`,
      async run() {
        const res = await fetchSingleRate(
          getBackend(),
          currencyCode,
          newSource as SourceName,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          settings.cryptoCompareApiKey,
          settings.settings.dpriceMode,
          settings.settings.dpriceUrl,
        );
        await loadRateSources();
        if (res.success) {
          await loadExchangeRates();
          toast.success(`Fetched ${currencyCode} rate from ${newSource}`);
        } else {
          toast.error(res.error ?? `Failed to fetch ${currencyCode} rate`);
        }
        return { summary: res.success ? `${currencyCode} rate fetched` : "Failed" };
      },
    });
  }

  // Default accounts state
  let defaultSet = $state<DefaultAccountSet>("standard");
  let creatingDefaults = $state(false);

  async function handleCreateDefaults() {
    creatingDefaults = true;
    try {
      const result = await createDefaultAccounts(getBackend(), defaultSet);
      if (result.created > 0) {
        toast.success(`Created ${result.created} accounts`);
      } else {
        toast.info("All default accounts already exist");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      creatingDefaults = false;
    }
  }

  // dprice state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  let dpriceHealth = $state<DpriceHealthResponse | null>(null);
  let dpriceLatest = $state<string | null>(null);
  let dpriceLoading = $state(false);
  let dpriceExporting = $state(false);
  let dpriceImporting = $state(false);
  let dpriceLocalPath = $state<string | null>(null);

  function dpriceClient() {
    return createDpriceClient({
      dpriceMode: settings.settings.dpriceMode,
      dpriceUrl: settings.settings.dpriceUrl,
    });
  }

  async function loadDpriceStatus() {
    if (!isDpriceActive(settings.settings.dpriceMode)) return;
    dpriceLoading = true;
    try {
      const client = dpriceClient();
      const [health, latest] = await Promise.all([
        client.health(),
        client.latestDate(),
      ]);
      dpriceHealth = health;
      dpriceLatest = latest;
    } catch {
      dpriceHealth = null;
      dpriceLatest = null;
    } finally {
      dpriceLoading = false;
    }
  }

  function dpriceStaleDays(): number | null {
    if (!dpriceLatest) return null;
    const latest = new Date(dpriceLatest);
    const now = new Date();
    return Math.floor((now.getTime() - latest.getTime()) / (1000 * 60 * 60 * 24));
  }

  function handleDpriceSyncLatest() {
    taskQueue.enqueue({
      key: "dprice-sync-latest",
      label: "dprice latest prices",
      async run() {
        await dpriceClient().syncLatest();
        await loadDpriceStatus();
        toast.success("dprice latest prices synced");
        return { summary: "dprice latest synced" };
      },
    });
  }

  function handleDpriceSyncFull() {
    taskQueue.enqueue({
      key: "dprice-sync-full",
      label: "dprice full sync",
      async run() {
        await dpriceClient().sync();
        await loadDpriceStatus();
        toast.success("dprice full sync completed");
        return { summary: "dprice full sync done" };
      },
    });
  }

  async function handleDpriceExport() {
    dpriceExporting = true;
    try {
      const data = await dpriceClient().exportDb();
      downloadDatabase(data, `dprice-backup-${new Date().toISOString().slice(0, 10)}.db`);
      toast.success("dprice database exported");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      dpriceExporting = false;
    }
  }

  function handleDpriceImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".db,.sqlite,.sqlite3";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!window.confirm(`Import "${file.name}" as dprice database? This will replace the current price database.`)) return;
      dpriceImporting = true;
      try {
        const data = await readFileAsUint8Array(file);
        await dpriceClient().importDb(data);
        toast.success("dprice database imported");
        await loadDpriceStatus();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        dpriceImporting = false;
      }
    };
    input.click();
  }

  async function loadDpriceLocalPath() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__TAURI_INTERNALS__) {
        const { invoke } = await import("@tauri-apps/api/core");
        dpriceLocalPath = await invoke<string>("dprice_local_db_path");
      }
    } catch {
      dpriceLocalPath = null;
    }
  }

  function handleDpriceToggle(enabled: boolean) {
    if (enabled) {
      const defaultMode: DpriceMode = isTauri ? "integrated" : "http";
      handleDpriceModeChange(defaultMode);
    } else {
      handleDpriceModeChange("off");
    }
  }

  async function handleDpriceModeChange(newMode: DpriceMode) {
    settings.update({ dpriceMode: newMode });
    if (isDpriceActive(newMode) && newMode !== "http") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).__TAURI_INTERNALS__) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("dprice_set_mode", { mode: newMode });
        }
      } catch (e) {
        toast.error(`Failed to switch dprice mode: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (isDpriceActive(newMode)) {
      await loadDpriceStatus();
    } else {
      dpriceHealth = null;
      dpriceLatest = null;
    }
  }

  onMount(() => {
    loadCurrencies();
    loadExchangeRates();
    loadRateSources();
    loadDpriceStatus();
    loadDpriceLocalPath();
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Settings</h1>
    <p class="text-muted-foreground">Configure application preferences.</p>
  </div>

  <!-- General -->
  <Card.Root>
    <Card.Header>
      <Card.Title>General</Card.Title>
      <Card.Description>Currency, date format, and fiscal year settings.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="space-y-2">
          <label for="currency" class="text-sm font-medium">Base Currency</label>
          <select
            id="currency"
            value={settings.currency}
            onchange={handleCurrencyChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#if currencies.length === 0}
              <option value={settings.currency}>{settings.currency}</option>
            {:else}
              {#each currencies as c}
                <option value={c.code}>{c.code} - {c.name}</option>
              {/each}
            {/if}
          </select>
        </div>

        <div class="space-y-2">
          <label for="date-format" class="text-sm font-medium">Date Format</label>
          <select
            id="date-format"
            value={settings.dateFormat}
            onchange={handleDateFormatChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#each dateFormats as df}
              <option value={df.value}>{df.label}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-2">
          <label for="fiscal-year" class="text-sm font-medium">Fiscal Year Start</label>
          <select
            id="fiscal-year"
            value={parseInt(settings.fiscalYearStart.split("-")[0], 10)}
            onchange={handleFiscalYearChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#each months as m, i}
              <option value={i + 1}>{m}</option>
            {/each}
          </select>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Currencies -->
  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Card.Title>Currencies</Card.Title>
          <Card.Description>Add currencies and manage rate sources.</Card.Description>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <ListFilter bind:value={currencySearchTerm} placeholder="Filter currencies..." />
          <label class="flex items-center gap-2 text-sm">
            <Switch
              checked={settings.showHidden}
              onCheckedChange={(v) => settings.update({ showHidden: v })}
            />
            Show hidden
          </label>
          <Button
            variant="outline"
            size="sm"
            onclick={async () => {
              await getBackend().clearAutoRateSources();
              await loadRateSources();
              toast.success("Auto-detected rate sources cleared. They will be re-detected on next sync.");
            }}
          >
            Re-detect Sources
          </Button>
        </div>
      </div>
    </Card.Header>
    <Card.Content class="space-y-4">
      <form onsubmit={(e) => { e.preventDefault(); addCurrency(); }} class="flex items-end gap-3">
        <div class="space-y-1">
          <label for="curr-code" class="text-xs text-muted-foreground">Code</label>
          <Input id="curr-code" bind:value={currCode} placeholder="EUR" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="curr-name" class="text-xs text-muted-foreground">Name</label>
          <Input id="curr-name" bind:value={currName} placeholder="Euro" class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="curr-decimals" class="text-xs text-muted-foreground">Decimals</label>
          <Input id="curr-decimals" type="number" bind:value={currDecimals} class="w-20" />
        </div>
        <div class="space-y-1 flex items-center gap-2 pb-1">
          <Switch id="curr-base" bind:checked={currIsBase} />
          <label for="curr-base" class="text-xs text-muted-foreground">Base</label>
        </div>
        <Button type="submit" size="sm">Add</Button>
      </form>

      <Separator />

      {#if currencies.length === 0}
        <p class="text-sm text-muted-foreground text-center py-4">No currencies defined.</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortCurr.key === "code"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("code")}>Code</SortableHeader>
              <SortableHeader active={sortCurr.key === "name"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("name")}>Name</SortableHeader>
              <SortableHeader active={sortCurr.key === "decimals"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("decimals")} class="text-right hidden md:table-cell">Decimals</SortableHeader>
              <SortableHeader active={sortCurr.key === "base"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("base")} class="hidden sm:table-cell">Base</SortableHeader>
              <SortableHeader active={sortCurr.key === "rateSource"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("rateSource")} class="hidden lg:table-cell">Rate Source</SortableHeader>
              <Table.Head class="text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const filteredCurrencies = currencies.filter((c) => (!c.is_hidden || settings.showHidden) && matchesFilter(c, currencySearchTerm.trim(), ["code", "name"]))}
            {@const sortedCurrencies = sortCurr.key && sortCurr.direction ? sortItems(filteredCurrencies, currencyAccessors[sortCurr.key], sortCurr.direction) : filteredCurrencies}
            {#each sortedCurrencies as c}
              {@const rs = rateSources.get(c.code)}
              <Table.Row>
                <Table.Cell class="font-mono">
                  {c.code}
                  {#if c.is_hidden}
                    <span class="ml-1 text-xs text-muted-foreground">(hidden)</span>
                  {/if}
                </Table.Cell>
                <Table.Cell>{c.name}</Table.Cell>
                <Table.Cell class="text-right hidden md:table-cell">{c.decimal_places}</Table.Cell>
                <Table.Cell class="hidden sm:table-cell">
                  {#if c.is_base}
                    <span class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Base</span>
                  {/if}
                </Table.Cell>
                <Table.Cell class="hidden lg:table-cell">
                  {#if !c.is_base}
                    <div class="flex items-center gap-2">
                      <select
                        value={rs?.rate_source ?? "auto"}
                        onchange={(e) => {
                          const val = (e.target as HTMLSelectElement).value;
                          handleSourceChange(c.code, val);
                        }}
                        disabled={taskQueue.isActive(`rate-refetch:${c.code}`)}
                        class="flex h-7 rounded-md border border-input bg-transparent px-2 py-0.5 text-sm disabled:opacity-50"
                      >
                        <option value="auto">auto-detect</option>
                        <option value="frankfurter">frankfurter</option>
                        <option value="defillama">defillama</option>
                        <option value="coingecko">coingecko</option>
                        <option value="cryptocompare">cryptocompare</option>
                        <option value="binance">binance</option>
                        <option value="finnhub">finnhub</option>
                        <option value="dprice">dprice</option>
                        <option value="none">none</option>
                      </select>
                      {#if rs?.set_by}
                        <span class="text-xs text-muted-foreground">{rs.set_by}</span>
                      {/if}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-right">
                  {#if !c.is_base}
                    {#if c.is_hidden}
                      <Button variant="ghost" size="sm" onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>Unhide</Button>
                    {:else}
                      <Button variant="ghost" size="sm" onclick={async () => { await markCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>Hide</Button>
                    {/if}
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}

      {@const hiddenCurrencies = currencies.filter((c) => c.is_hidden)}
      {#if hiddenCurrencies.length > 0 && !settings.showHidden}
        <Separator />
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium">Hidden Currencies ({hiddenCurrencies.length})</h3>
            <Button variant="outline" size="sm" onclick={async () => {
              for (const c of hiddenCurrencies) {
                await unmarkCurrencyHidden(getBackend(), c.code);
              }
              await loadCurrencies();
            }}>Unhide All</Button>
          </div>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Code</Table.Head>
                <Table.Head>Name</Table.Head>
                <Table.Head class="text-right">Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each hiddenCurrencies as c}
                <Table.Row>
                  <Table.Cell class="font-mono">{c.code}</Table.Cell>
                  <Table.Cell>{c.name}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Button variant="ghost" size="sm" onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>Unhide</Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- Exchange Rates -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Exchange Rates</Card.Title>
      <Card.Description>Manually record exchange rates for currency conversions.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <form onsubmit={(e) => { e.preventDefault(); addExchangeRate(); }} class="flex items-end gap-3">
        <div class="space-y-1">
          <label for="rate-from" class="text-xs text-muted-foreground">From</label>
          <Input id="rate-from" bind:value={rateFrom} placeholder="BTC" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="rate-to" class="text-xs text-muted-foreground">To</label>
          <Input id="rate-to" bind:value={rateTo} placeholder="EUR" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="rate-val" class="text-xs text-muted-foreground">Rate</label>
          <Input id="rate-val" bind:value={rateValue} placeholder="45000.00" class="w-36" />
        </div>
        <div class="space-y-1">
          <label for="rate-date" class="text-xs text-muted-foreground">Date</label>
          <Input id="rate-date" type="date" bind:value={rateDate} class="w-40" />
        </div>
        <Button type="submit" size="sm">Add Rate</Button>
      </form>

      <Separator />

      {#if ratesLoading}
        <p class="text-sm text-muted-foreground">Loading exchange rates...</p>
      {:else if exchangeRates.length === 0}
        <p class="text-sm text-muted-foreground text-center py-4">No exchange rates recorded.</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortRates.key === "date"} direction={sortRates.direction} onclick={() => sortRates.toggle("date")}>Date</SortableHeader>
              <SortableHeader active={sortRates.key === "from"} direction={sortRates.direction} onclick={() => sortRates.toggle("from")}>From</SortableHeader>
              <SortableHeader active={sortRates.key === "to"} direction={sortRates.direction} onclick={() => sortRates.toggle("to")}>To</SortableHeader>
              <SortableHeader active={sortRates.key === "rate"} direction={sortRates.direction} onclick={() => sortRates.toggle("rate")} class="text-right">Rate</SortableHeader>
              <SortableHeader active={sortRates.key === "source"} direction={sortRates.direction} onclick={() => sortRates.toggle("source")}>Source</SortableHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const sortedRates = sortRates.key && sortRates.direction ? sortItems(exchangeRates, rateAccessors[sortRates.key], sortRates.direction).slice(0, 50) : exchangeRates.slice(0, 50)}
            {#each sortedRates as rate}
              <Table.Row>
                <Table.Cell>{rate.date}</Table.Cell>
                <Table.Cell>{rate.from_currency}</Table.Cell>
                <Table.Cell>{rate.to_currency}</Table.Cell>
                <Table.Cell class="text-right font-mono">{rate.rate}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{rate.source}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
        {#if exchangeRates.length > 50}
          <p class="text-xs text-muted-foreground text-center">Showing first 50 of {exchangeRates.length} rates.</p>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- Appearance -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Appearance</Card.Title>
      <Card.Description>Theme and display preferences.</Card.Description>
    </Card.Header>
    <Card.Content>
      <p class="text-sm text-muted-foreground">
        Use the theme toggle in the top bar to switch between light and dark mode.
      </p>
    </Card.Content>
  </Card.Root>

  <!-- Backup & Restore -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Backup & Restore</Card.Title>
      <Card.Description>Export or import your database file.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Export Database</p>
          <p class="text-sm text-muted-foreground">Download a .db backup file containing all your data.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={exporting}
          onclick={async () => {
            exporting = true;
            try {
              const data = await exportDatabaseBackup(getBackend());
              downloadDatabase(data);
              toast.success("Database exported");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e));
            } finally {
              exporting = false;
            }
          }}
        >
          {exporting ? "Exporting..." : "Export .db"}
        </Button>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Import Database</p>
          <p class="text-sm text-muted-foreground">Restore from a .db backup file. This replaces all current data.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={importing}
          onclick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".db,.sqlite,.sqlite3";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              if (!window.confirm(`Import "${file.name}"? This will replace ALL current data. This cannot be undone.`)) return;
              importing = true;
              try {
                const data = await readFileAsUint8Array(file);
                const backend = getBackend();
                if (!backend.importDatabase) {
                  throw new Error("Import not supported by this backend");
                }
                await backend.importDatabase(data);
                toast.success("Database imported. Reloading...");
                setTimeout(() => window.location.reload(), 500);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e));
              } finally {
                importing = false;
              }
            };
            input.click();
          }}
        >
          {importing ? "Importing..." : "Import .db"}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- ML Classification -->
  <Card.Root>
    <Card.Header>
      <Card.Title>ML Classification</Card.Title>
      <Card.Description>Use in-browser machine learning to auto-classify imported transactions.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Enable ML-powered classification</p>
          <p class="text-sm text-muted-foreground">Shows a "Classify with AI" button in import dialogs.</p>
        </div>
        <Switch
          checked={settings.settings.mlClassificationEnabled ?? false}
          onCheckedChange={(v) => settings.update({ mlClassificationEnabled: v })}
        />
      </div>
      {#if settings.settings.mlClassificationEnabled}
        <Separator />
        <div class="space-y-2">
          <label for="ml-threshold" class="text-sm font-medium">
            Confidence threshold: {Math.round((settings.settings.mlConfidenceThreshold ?? 0.5) * 100)}%
          </label>
          <input
            id="ml-threshold"
            type="range"
            min="0.3"
            max="0.9"
            step="0.05"
            value={settings.settings.mlConfidenceThreshold ?? 0.5}
            oninput={(e) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              settings.update({ mlConfidenceThreshold: v });
            }}
            class="w-full accent-primary"
          />
          <p class="text-xs text-muted-foreground">
            Suggestions below this confidence are discarded. Higher = fewer but more accurate suggestions.
          </p>
        </div>
        <Separator />
        <div class="space-y-2">
          <p class="text-xs text-muted-foreground">
            Models (~70 MB total) are downloaded from HuggingFace on first use and cached in the browser.
            Classification runs entirely in your browser — no data is sent to external servers.
          </p>
          <Button
            variant="outline"
            size="sm"
            onclick={async () => {
              try {
                const cacheNames = await caches.keys();
                let deleted = 0;
                for (const name of cacheNames) {
                  if (name.includes("transformers")) {
                    await caches.delete(name);
                    deleted++;
                  }
                }
                toast.success(deleted > 0 ? "Cached models cleared" : "No cached models found");
              } catch {
                toast.error("Failed to clear cached models");
              }
            }}
          >
            Clear cached models
          </Button>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- dprice Price Database -->
  <Card.Root>
    <Card.Header>
      <Card.Title>dprice Price Database</Card.Title>
      <Card.Description>Use a dedicated price database for exchange rates. Syncs from ECB, CryptoCompare, DefiLlama, and Binance.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Enable dprice rate source</p>
          <p class="text-sm text-muted-foreground">Use dprice as an exchange rate source.</p>
        </div>
        <Switch
          checked={isDpriceActive(settings.settings.dpriceMode)}
          onCheckedChange={handleDpriceToggle}
        />
      </div>
      {#if isDpriceActive(settings.settings.dpriceMode)}
        {#if isTauri}
          <div class="space-y-2">
            <label for="dprice-mode" class="text-sm font-medium">Mode</label>
            <select
              id="dprice-mode"
              class="flex h-9 w-60 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={settings.settings.dpriceMode}
              onchange={(e) => handleDpriceModeChange((e.target as HTMLSelectElement).value as DpriceMode)}
            >
              <option value="integrated">Integrated (app-managed DB)</option>
              <option value="local">Local (shared CLI DB)</option>
              <option value="http">HTTP API (external server)</option>
            </select>
            <p class="text-xs text-muted-foreground">
              {#if settings.settings.dpriceMode === "integrated"}
                Uses a co-located database managed by the app.
              {:else if settings.settings.dpriceMode === "local"}
                Shares the database with the <code>dprice</code> CLI tool.
              {:else if settings.settings.dpriceMode === "http"}
                Connects to an external <code>dprice serve</code> instance.
              {/if}
            </p>
          </div>
        {:else}
          <p class="text-xs text-muted-foreground">Using HTTP API mode. Configure the server URL below.</p>
        {/if}
        {#if settings.settings.dpriceMode === "http"}
          <Separator />
          <div class="space-y-2">
            <label for="dprice-url" class="text-sm font-medium">Server URL</label>
            <Input
              id="dprice-url"
              value={settings.settings.dpriceUrl ?? "http://localhost:3080"}
              oninput={(e) => settings.update({ dpriceUrl: (e.target as HTMLInputElement).value || undefined })}
              placeholder="http://localhost:3080"
              class="w-80"
            />
          </div>
        {/if}
        {#if settings.settings.dpriceMode === "local" && dpriceLocalPath}
          <div class="rounded-md border bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">Database path: <code>{dpriceLocalPath}</code></p>
          </div>
        {/if}
        <Separator />
        <div class="space-y-2">
          {#if dpriceLoading}
            <p class="text-sm text-muted-foreground">Loading status...</p>
          {:else if dpriceHealth}
            <p class="text-sm">
              <span class="font-medium">Status:</span>
              {dpriceHealth.assets.toLocaleString()} assets, {dpriceHealth.prices.toLocaleString()} prices
            </p>
            {#if dpriceLatest}
              {@const days = dpriceStaleDays()}
              {#if days !== null && days > 2}
                <p class="text-sm text-amber-600 dark:text-amber-400">
                  Data is stale (last update: {dpriceLatest}, {days} days ago)
                </p>
              {:else}
                <p class="text-sm text-muted-foreground">
                  Last updated: {dpriceLatest}{days !== null ? ` (${days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`})` : ""}
                </p>
              {/if}
            {:else}
              <p class="text-sm text-muted-foreground">No price data yet. Run a sync to populate.</p>
            {/if}
          {:else}
            <p class="text-sm text-muted-foreground">Could not load dprice status. Is the database accessible?</p>
          {/if}
        </div>
        {#if settings.settings.dpriceMode === "integrated"}
          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={taskQueue.isActive("dprice-sync-latest") || taskQueue.isActive("dprice-sync-full")}
              onclick={handleDpriceSyncLatest}
            >
              {taskQueue.isActive("dprice-sync-latest") ? "Syncing..." : "Sync Latest"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={taskQueue.isActive("dprice-sync-latest") || taskQueue.isActive("dprice-sync-full")}
              onclick={handleDpriceSyncFull}
            >
              {taskQueue.isActive("dprice-sync-full") ? "Syncing..." : "Full Sync"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={dpriceExporting}
              onclick={handleDpriceExport}
            >
              {dpriceExporting ? "Exporting..." : "Export DB"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={dpriceImporting}
              onclick={handleDpriceImport}
            >
              {dpriceImporting ? "Importing..." : "Import DB"}
            </Button>
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- Account Paths -->
  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Card.Title>Account Paths</Card.Title>
          <Card.Description>Customize the account paths used by future imports. Existing accounts are not automatically renamed.</Card.Description>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" onclick={countAffectedAccounts} disabled={pathRenaming}>
            Check Existing
          </Button>
          {#if renameCounts.size > 0}
            <Button variant="default" size="sm" onclick={handleRenameAll} disabled={pathRenaming}>
              {pathRenaming ? "Renaming..." : `Rename ${[...renameCounts.values()].reduce((a, b) => a + b, 0)} accounts`}
            </Button>
          {/if}
        </div>
      </div>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#each PATH_SECTIONS as section}
        <Collapsible.Root>
          <div class="flex items-center justify-between">
            <Collapsible.Trigger class="flex items-center gap-2 text-sm font-medium hover:underline">
              <span class="i-lucide-chevron-right h-4 w-4 transition-transform [[data-state=open]>&]:rotate-90">&#9654;</span>
              {section.title}
            </Collapsible.Trigger>
            <Button
              variant="ghost"
              size="sm"
              onclick={() => resetPathSection(section.keys.map((k) => k.key))}
            >
              Reset
            </Button>
          </div>
          <p class="text-xs text-muted-foreground mb-2">{section.description}</p>
          <Collapsible.Content>
            <div class="space-y-3 pl-2">
              {#each section.keys as { key, label, example }}
                {@const err = pathErrors(key)}
                {@const value = getPathValue(key)}
                {@const isDefault = value === DEFAULT_PATH_CONFIG[key]}
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <label for="path-{key}" class="text-xs text-muted-foreground w-36 shrink-0">{label}</label>
                    <Input
                      id="path-{key}"
                      value={value}
                      oninput={(e) => handlePathChange(key, (e.target as HTMLInputElement).value)}
                      class="font-mono text-xs {err ? 'border-destructive' : ''} {!isDefault ? 'border-primary' : ''}"
                    />
                  </div>
                  <div class="flex items-center gap-2 pl-38">
                    <span class="text-xs text-muted-foreground font-mono">{value}:{example}</span>
                    {#if err}
                      <span class="text-xs text-destructive">{err}</span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
        {#if section !== PATH_SECTIONS[PATH_SECTIONS.length - 1]}
          <Separator />
        {/if}
      {/each}
    </Card.Content>
  </Card.Root>

  <!-- Default Accounts -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Default Accounts</Card.Title>
      <Card.Description>Create a starter chart of accounts. Existing accounts are preserved.</Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <select
            bind:value={defaultSet}
            class="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            <option value="minimal">Minimal (~25)</option>
            <option value="standard">Standard (~45)</option>
            <option value="comprehensive">Comprehensive (~65)</option>
          </select>
        </div>
        <Button variant="outline" size="sm" onclick={handleCreateDefaults} disabled={creatingDefaults}>
          {creatingDefaults ? "Creating..." : "Create Accounts"}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Data Management -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Data Management</Card.Title>
      <Card.Description>Clear stored data. These actions cannot be undone.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear Exchange Rates</p>
          <p class="text-sm text-muted-foreground">Remove all synced and manual exchange rates.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearExchangeRates} disabled={clearing}>
          {taskQueue.isActive("clear-exchange-rates") ? "Clearing..." : "Clear Rates"}
        </Button>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear Ledger Data</p>
          <p class="text-sm text-muted-foreground">Remove all accounts, transactions, and currencies. Exchange rates, sources, and settings are preserved.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearLedgerData} disabled={clearing}>
          {taskQueue.isActive("clear-ledger-data") ? "Clearing..." : "Clear Ledger"}
        </Button>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear All Data</p>
          <p class="text-sm text-muted-foreground">Delete all accounts, transactions, currencies, exchange rates, and reset settings.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearAllData} disabled={clearing}>
          {taskQueue.isActive("clear-all-data") ? "Clearing..." : "Clear All Data"}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if import.meta.env.DEV}
    <Card.Root>
      <Card.Header>
        <Card.Title>Development</Card.Title>
        <Card.Description>Debug tools (only visible in dev mode).</Card.Description>
      </Card.Header>
      <Card.Content>
        <label class="flex items-center gap-2 text-sm">
          <Switch
            checked={settings.debugMode}
            onCheckedChange={(v) => settings.update({ debugMode: v })}
          />
          Debug Mode
        </label>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
