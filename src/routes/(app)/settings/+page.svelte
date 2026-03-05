<script lang="ts">
    import { onMount } from "svelte";
    import * as Card from "$lib/components/ui/card/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Switch } from "$lib/components/ui/switch/index.js";
    import { Separator } from "$lib/components/ui/separator/index.js";
    import * as Tabs from "$lib/components/ui/tabs/index.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { getBackend } from "$lib/backend.js";
    import { reloadHiddenCurrencies } from "$lib/data/hidden-currencies.svelte.js";
    import type { Currency } from "$lib/types/index.js";
    import type { CurrencyAssetType } from "$lib/types/account.js";
    import { inferAssetType } from "$lib/currency-type.js";
    import { toast } from "svelte-sonner";
    import {
        exportDatabaseBackup,
        readFileAsUint8Array,
        downloadDatabase,
    } from "$lib/utils/database-export.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import {
        createDpriceClient,
        type DpriceHealthResponse,
    } from "$lib/dprice-client.js";
    import {
        isDpriceActive,
        type DpriceMode,
    } from "$lib/data/settings.svelte.js";
    import * as Collapsible from "$lib/components/ui/collapsible/index.js";
    import * as Select from "$lib/components/ui/select/index.js";
    import ListFilter from "$lib/components/ListFilter.svelte";
    import { invalidate } from "$lib/data/invalidation.js";
    import {
        DEFAULT_PATH_CONFIG,
        PATH_TYPE_CONSTRAINTS,
        getAccountPathConfig,
        validatePathConfig,
        type AccountPathConfig,
    } from "$lib/accounts/paths.js";
    import {
        createDefaultAccounts,
        type DefaultAccountSet,
    } from "$lib/accounts/defaults.js";
    import {
        testFrankfurter,
        testFinnhub,
        testCoinGecko,
        testCryptoCompare,
        testDefiLlama,
        testBinance,
        testEtherscan,
        testRoutescan,
        testTheGraph,
        testDprice,
        type TestResult,
    } from "$lib/service-test.js";
    const settings = new SettingsStore();

    // Service test state
    let testResults = $state<Record<string, { status: 'idle' | 'testing' | 'success' | 'error'; message?: string }>>({});

    async function handleTest(service: string, testFn: () => Promise<TestResult>) {
        testResults = { ...testResults, [service]: { status: 'testing' } };
        try {
            const r = await testFn();
            testResults = { ...testResults, [service]: r.ok
                ? { status: 'success', message: r.detail }
                : { status: 'error', message: r.error }
            };
        } catch (e) {
            testResults = { ...testResults, [service]: { status: 'error', message: String(e) } };
        }
    }

    // Account Paths state
    let pathOverrides = $state<Partial<AccountPathConfig>>(
        settings.settings.accountPaths
            ? { ...settings.settings.accountPaths }
            : {},
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
            settings.update({
                accountPaths:
                    Object.keys(pathOverrides).length > 0
                        ? pathOverrides
                        : undefined,
            });
        }
    }

    function resetPathSection(keys: (keyof AccountPathConfig)[]) {
        const next = { ...pathOverrides };
        for (const k of keys) delete next[k];
        pathOverrides = next;
        settings.update({
            accountPaths:
                Object.keys(pathOverrides).length > 0
                    ? pathOverrides
                    : undefined,
        });
    }

    async function countAffectedAccounts() {
        try {
            const accounts = await getBackend().listAccounts();
            const counts = new Map<string, number>();
            const saved = settings.settings.accountPaths ?? {};
            for (const [key, defaultVal] of Object.entries(
                DEFAULT_PATH_CONFIG,
            )) {
                const currentVal = saved[key as keyof AccountPathConfig];
                if (currentVal && currentVal !== defaultVal) {
                    // Count accounts under the OLD prefix (the default one) that could be renamed
                    const prefix = defaultVal;
                    const count = accounts.filter(
                        (a) =>
                            a.full_name === prefix ||
                            a.full_name.startsWith(prefix + ":"),
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
            for (const [key, defaultVal] of Object.entries(
                DEFAULT_PATH_CONFIG,
            )) {
                const newVal = saved[key as keyof AccountPathConfig];
                if (newVal && newVal !== defaultVal) {
                    const result = await backend.renameAccountPrefix(
                        defaultVal,
                        newVal,
                    );
                    totalRenamed += result.renamed;
                    totalSkipped += result.skipped;
                }
            }
            if (totalRenamed > 0) {
                toast.success(
                    `Renamed ${totalRenamed} account${totalRenamed !== 1 ? "s" : ""}${totalSkipped > 0 ? ` (${totalSkipped} skipped)` : ""}`,
                );
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

    const PATH_SECTIONS: {
        title: string;
        description: string;
        keys: {
            key: keyof AccountPathConfig;
            label: string;
            example: string;
        }[];
    }[] = [
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
            description:
                "Paths for crypto exchange imports and CEX integration.",
            keys: [
                {
                    key: "exchangeAssets",
                    label: "Exchange Assets",
                    example: "Kraken",
                },
                {
                    key: "exchangeFees",
                    label: "Exchange Fees",
                    example: "Kraken",
                },
                {
                    key: "exchangeEquity",
                    label: "Exchange Equity",
                    example: "Kraken",
                },
                {
                    key: "exchangeStaking",
                    label: "Exchange Staking",
                    example: "Kraken",
                },
                {
                    key: "exchangeIncome",
                    label: "Exchange Income",
                    example: "Nexo",
                },
                {
                    key: "exchangeExpenses",
                    label: "Exchange Expenses",
                    example: "CryptoCom",
                },
            ],
        },
        {
            title: "Wallet / On-chain",
            description: "Paths for on-chain wallet and gas fee accounts.",
            keys: [
                {
                    key: "walletAssets",
                    label: "Wallet Assets",
                    example: "Ethereum:Main",
                },
                {
                    key: "walletEquity",
                    label: "Wallet Equity",
                    example: "Ethereum",
                },
                { key: "chainFees", label: "Chain Fees", example: "Ethereum" },
            ],
        },
        {
            title: "DeFi",
            description:
                "Paths for DeFi protocol accounts (Aave, Uniswap, etc.).",
            keys: [
                {
                    key: "defiAssets",
                    label: "DeFi Assets",
                    example: "Aave:Supply",
                },
                {
                    key: "defiLiabilities",
                    label: "DeFi Liabilities",
                    example: "Aave:Borrow",
                },
                {
                    key: "defiIncome",
                    label: "DeFi Income",
                    example: "Aave:Interest",
                },
                {
                    key: "defiExpenses",
                    label: "DeFi Expenses",
                    example: "Aave:Interest",
                },
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

    // Currency list from backend (needed for base currency select + asset type overrides)
    let currencies = $state<Currency[]>([]);

    // Currency asset type override state
    const ASSET_TYPES: { value: CurrencyAssetType; label: string }[] = [
        { value: "", label: "Unclassified" },
        { value: "fiat", label: "Fiat" },
        { value: "crypto", label: "Crypto" },
        { value: "stock", label: "Stock" },
        { value: "commodity", label: "Commodity" },
        { value: "index", label: "Index" },
        { value: "bond", label: "Bond" },
    ];
    let assetTypeEdits = $state<Map<string, CurrencyAssetType>>(new Map());
    let savingAssetTypes = $state(false);
    let assetTypesOpen = $state(false);
    let assetTypeSearch = $state("");
    const visibleCurrencies = $derived.by(() => {
        const visible = currencies.filter((c) => !c.is_hidden);
        if (!assetTypeSearch) return visible;
        const q = assetTypeSearch.toLowerCase();
        return visible.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    });

    async function saveAssetTypeOverrides() {
        if (assetTypeEdits.size === 0) return;
        savingAssetTypes = true;
        try {
            const backend = getBackend();
            for (const [code, newType] of assetTypeEdits) {
                await backend.setCurrencyAssetType(code, newType);
            }
            assetTypeEdits = new Map();
            await loadCurrencies();
            invalidate("currencies");
            toast.success(`Asset type overrides saved`);
        } catch (err) {
            toast.error(`Failed to save: ${err}`);
        } finally {
            savingAssetTypes = false;
        }
    }

    const dateFormats = [
        { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO)" },
        { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
        { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
    ];

    const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];

    async function loadCurrencies() {
        try {
            currencies = await getBackend().listCurrencies();
        } catch {
            currencies = [];
        }
    }

    function handleCurrencyChange(val: string) {
        settings.update({ currency: val });
    }

    function handleDateFormatChange(val: string) {
        settings.update({ dateFormat: val });
    }

    function handleFiscalYearChange(val: string) {
        const month = parseInt(val, 10);
        const mm = String(month).padStart(2, "0");
        settings.update({ fiscalYearStart: `${mm}-01` });
    }

    const clearing = $derived(
        taskQueue.isActive("clear-exchange-rates") ||
            taskQueue.isActive("clear-ledger-data") ||
            taskQueue.isActive("clear-all-data"),
    );

    function handleClearExchangeRates() {
        if (
            !window.confirm(
                "Are you sure you want to clear all exchange rates? This cannot be undone.",
            )
        )
            return;
        taskQueue.enqueue({
            key: "clear-exchange-rates",
            label: "Clear exchange rates",
            async run() {
                await getBackend().clearExchangeRates();
                await getBackend().clearAutoRateSources();
                invalidate("currencies");
                toast.success("Exchange rates cleared");
                return { summary: "Exchange rates cleared" };
            },
        });
    }

    function handleClearLedgerData() {
        if (
            !window.confirm(
                "Are you sure you want to clear all ledger data? This will remove all accounts, transactions, and currencies. Exchange rates, sources, and settings will be preserved. This cannot be undone.",
            )
        )
            return;
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
        if (
            !window.confirm(
                "Are you sure you want to delete ALL data? This will remove all accounts, transactions, currencies, exchange rates, and reset settings. This cannot be undone.",
            )
        )
            return;
        taskQueue.enqueue({
            key: "clear-all-data",
            label: "Clear all data",
            async run() {
                await getBackend().clearAllData();
                settings.reset();
                currencies = [];
                invalidate("currencies");
                toast.success("All data cleared");
                return { summary: "All data cleared" };
            },
        });
    }

    // Default accounts state
    let defaultSet = $state<DefaultAccountSet>("standard");
    let creatingDefaults = $state(false);

    async function handleCreateDefaults() {
        creatingDefaults = true;
        try {
            const result = await createDefaultAccounts(
                getBackend(),
                defaultSet,
            );
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
    const isTauri =
        typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
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
        return Math.floor(
            (now.getTime() - latest.getTime()) / (1000 * 60 * 60 * 24),
        );
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
            downloadDatabase(
                data,
                `dprice-backup-${new Date().toISOString().slice(0, 10)}.db`,
            );
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
            if (
                !window.confirm(
                    `Import "${file.name}" as dprice database? This will replace the current price database.`,
                )
            )
                return;
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
                toast.error(
                    `Failed to switch dprice mode: ${e instanceof Error ? e.message : String(e)}`,
                );
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
            <Card.Description
                >Currency, date format, and fiscal year settings.</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="space-y-2">
                    <span class="text-sm font-medium">Base Currency</span>
                    <Select.Root type="single" value={settings.currency} onValueChange={handleCurrencyChange}>
                        <Select.Trigger class="w-full">
                            {#if currencies.length === 0}
                                {settings.currency}
                            {:else}
                                {@const cur = currencies.find((c) => c.code === settings.currency)}
                                {cur ? `${cur.code} - ${cur.name}` : settings.currency}
                            {/if}
                        </Select.Trigger>
                        <Select.Content>
                            {#if currencies.length === 0}
                                <Select.Item value={settings.currency}>{settings.currency}</Select.Item>
                            {:else}
                                {#each currencies as c (c.code)}
                                    <Select.Item value={c.code}>{c.code} - {c.name}</Select.Item>
                                {/each}
                            {/if}
                        </Select.Content>
                    </Select.Root>
                </div>

                <div class="space-y-2">
                    <span class="text-sm font-medium">Date Format</span>
                    <Select.Root type="single" value={settings.dateFormat} onValueChange={handleDateFormatChange}>
                        <Select.Trigger class="w-full">
                            {dateFormats.find((df) => df.value === settings.dateFormat)?.label ?? settings.dateFormat}
                        </Select.Trigger>
                        <Select.Content>
                            {#each dateFormats as df (df.value)}
                                <Select.Item value={df.value}>{df.label}</Select.Item>
                            {/each}
                        </Select.Content>
                    </Select.Root>
                </div>

                <div class="space-y-2">
                    <span class="text-sm font-medium">Fiscal Year Start</span>
                    <Select.Root type="single" value={String(parseInt(settings.fiscalYearStart.split("-")[0], 10))} onValueChange={handleFiscalYearChange}>
                        <Select.Trigger class="w-full">
                            {months[parseInt(settings.fiscalYearStart.split("-")[0], 10) - 1] ?? "January"}
                        </Select.Trigger>
                        <Select.Content>
                            {#each months as m, i (i)}
                                <Select.Item value={String(i + 1)}>{m}</Select.Item>
                            {/each}
                        </Select.Content>
                    </Select.Root>
                </div>
            </div>
            <p class="text-xs text-muted-foreground">
                Manage currencies on the <a href="/currencies" class="underline"
                    >Currencies</a
                > page.
            </p>
        </Card.Content>
    </Card.Root>

    <!-- Appearance -->
    <Card.Root>
        <Card.Header>
            <Card.Title>Appearance</Card.Title>
            <Card.Description>Theme and display preferences.</Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
            <p class="text-sm text-muted-foreground">
                Use the theme toggle in the top bar to switch between light and
                dark mode.
            </p>
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">Journal amount bars</p>
                    <p class="text-sm text-muted-foreground">Show colored bars indicating relative transaction amounts.</p>
                </div>
                <Switch checked={settings.settings.journalAmountBars !== false}
                    onCheckedChange={(v) => settings.update({ journalAmountBars: v })} />
            </div>
        </Card.Content>
    </Card.Root>

    <!-- Backup & Restore -->
    <Card.Root>
        <Card.Header>
            <Card.Title>Backup & Restore</Card.Title>
            <Card.Description
                >Export or import your database file.</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">Export Database</p>
                    <p class="text-sm text-muted-foreground">
                        Download a .db backup file containing all your data.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={exporting}
                    onclick={async () => {
                        exporting = true;
                        try {
                            const data =
                                await exportDatabaseBackup(getBackend());
                            downloadDatabase(data);
                            toast.success("Database exported");
                        } catch (e) {
                            toast.error(
                                e instanceof Error ? e.message : String(e),
                            );
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
                    <p class="text-sm text-muted-foreground">
                        Restore from a .db backup file. This replaces all
                        current data.
                    </p>
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
                            if (
                                !window.confirm(
                                    `Import "${file.name}"? This will replace ALL current data. This cannot be undone.`,
                                )
                            )
                                return;
                            importing = true;
                            try {
                                const data = await readFileAsUint8Array(file);
                                const backend = getBackend();
                                if (!backend.importDatabase) {
                                    throw new Error(
                                        "Import not supported by this backend",
                                    );
                                }
                                await backend.importDatabase(data);
                                toast.success(
                                    "Database imported. Reloading...",
                                );
                                setTimeout(() => window.location.reload(), 500);
                            } catch (e) {
                                toast.error(
                                    e instanceof Error ? e.message : String(e),
                                );
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
            <Card.Description
                >Use in-browser machine learning to auto-classify imported
                transactions.</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">
                        Enable ML-powered classification
                    </p>
                    <p class="text-sm text-muted-foreground">
                        Shows a "Classify with AI" button in import dialogs.
                    </p>
                </div>
                <Switch
                    checked={settings.settings.mlClassificationEnabled ?? false}
                    onCheckedChange={(v) =>
                        settings.update({ mlClassificationEnabled: v })}
                />
            </div>
            {#if settings.settings.mlClassificationEnabled}
                <Separator />
                <div class="space-y-2">
                    <label for="ml-threshold" class="text-sm font-medium">
                        Confidence threshold: {Math.round(
                            (settings.settings.mlConfidenceThreshold ?? 0.5) *
                                100,
                        )}%
                    </label>
                    <input
                        id="ml-threshold"
                        type="range"
                        min="0.3"
                        max="0.9"
                        step="0.05"
                        value={settings.settings.mlConfidenceThreshold ?? 0.5}
                        oninput={(e) => {
                            const v = parseFloat(
                                (e.target as HTMLInputElement).value,
                            );
                            settings.update({ mlConfidenceThreshold: v });
                        }}
                        class="w-full accent-primary"
                    />
                    <p class="text-xs text-muted-foreground">
                        Suggestions below this confidence are discarded. Higher
                        = fewer but more accurate suggestions.
                    </p>
                </div>
                <Separator />
                <div class="space-y-2">
                    <p class="text-xs text-muted-foreground">
                        Models (~70 MB total) are downloaded from HuggingFace on
                        first use and cached in the browser. Classification runs
                        entirely in your browser — no data is sent to external
                        servers.
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
                                toast.success(
                                    deleted > 0
                                        ? "Cached models cleared"
                                        : "No cached models found",
                                );
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

    <!-- Currency Asset Types -->
    <Card.Root>
        <Card.Header>
            <div class="flex items-center justify-between">
                <div>
                    <Card.Title>Currency Asset Types</Card.Title>
                    <Card.Description
                        >Override the auto-detected asset type for currencies. This affects which rate source is used for exchange rate sync.</Card.Description
                    >
                </div>
                {#if currencies.filter((c) => !c.is_hidden).length > 0}
                    <Button variant="outline" size="sm" onclick={() => (assetTypesOpen = !assetTypesOpen)}>
                        {assetTypesOpen ? "Hide" : "Show"} ({currencies.filter((c) => !c.is_hidden).length}){#if assetTypeEdits.size > 0} &middot; {assetTypeEdits.size} modified{/if}
                    </Button>
                {/if}
            </div>
        </Card.Header>
        {#if currencies.filter((c) => !c.is_hidden).length === 0}
            <Card.Content>
                <p class="text-muted-foreground text-sm">No currencies found. Create currencies first.</p>
            </Card.Content>
        {:else if assetTypesOpen}
            <Card.Content class="space-y-3">
                <ListFilter bind:value={assetTypeSearch} placeholder="Filter currencies..." />
                <div class="max-h-[400px] overflow-y-auto space-y-2">
                    {#each visibleCurrencies as cur (cur.code)}
                        {@const currentType = assetTypeEdits.get(cur.code) ?? cur.asset_type}
                        <div class="flex items-center gap-3">
                            <span class="w-20 font-mono text-sm">{cur.code}</span>
                            <Select.Root type="single" value={currentType} onValueChange={(val) => {
                                const newType = val as CurrencyAssetType;
                                if (newType === cur.asset_type) {
                                    const next = new Map(assetTypeEdits);
                                    next.delete(cur.code);
                                    assetTypeEdits = next;
                                } else {
                                    assetTypeEdits = new Map(assetTypeEdits).set(cur.code, newType);
                                }
                            }}>
                                <Select.Trigger class="h-8 text-sm">
                                    {ASSET_TYPES.find((at) => at.value === currentType)?.label ?? "Unclassified"}
                                </Select.Trigger>
                                <Select.Content>
                                    {#each ASSET_TYPES as at (at.value)}
                                        <Select.Item value={at.value}>{at.label}</Select.Item>
                                    {/each}
                                </Select.Content>
                            </Select.Root>
                            {#if assetTypeEdits.has(cur.code)}
                                <span class="text-xs text-yellow-500">modified</span>
                            {/if}
                        </div>
                    {/each}
                    {#if visibleCurrencies.length === 0}
                        <p class="text-sm text-muted-foreground">No currencies match &ldquo;{assetTypeSearch}&rdquo;.</p>
                    {/if}
                </div>
                {#if assetTypeEdits.size > 0}
                    <div class="flex gap-2">
                        <Button size="sm" onclick={saveAssetTypeOverrides} disabled={savingAssetTypes}>
                            {savingAssetTypes ? "Saving..." : `Save ${assetTypeEdits.size} change${assetTypeEdits.size > 1 ? "s" : ""}`}
                        </Button>
                        <Button size="sm" variant="outline" onclick={() => (assetTypeEdits = new Map())}>
                            Discard
                        </Button>
                    </div>
                {/if}
            </Card.Content>
        {/if}
    </Card.Root>

    <!-- External Services -->
    <Card.Root>
        <Card.Header>
            <Card.Title>External Services</Card.Title>
            <Card.Description
                >API keys and configuration for external data providers.</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <Tabs.Root value="general">
                <Tabs.List>
                    <Tabs.Trigger value="general">General</Tabs.Trigger>
                    <Tabs.Trigger value="fiat">Fiat</Tabs.Trigger>
                    <Tabs.Trigger value="stock">Stocks</Tabs.Trigger>
                    <Tabs.Trigger value="crypto">Crypto</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="general" class="space-y-4">
                    <div class="space-y-2">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-sm font-medium">
                                    dprice Price Database
                                </p>
                                <p class="text-sm text-muted-foreground">
                                    Dedicated price DB — syncs from ECB,
                                    CryptoCompare, DefiLlama, and Binance.
                                </p>
                            </div>
                            <Switch
                                checked={isDpriceActive(
                                    settings.settings.dpriceMode,
                                )}
                                onCheckedChange={handleDpriceToggle}
                            />
                        </div>
                        {#if isDpriceActive(settings.settings.dpriceMode)}
                            {#if isTauri}
                                <div class="space-y-2">
                                    <span class="text-sm font-medium">Mode</span>
                                    <Select.Root type="single" value={settings.settings.dpriceMode} onValueChange={(val) => handleDpriceModeChange(val as DpriceMode)}>
                                        <Select.Trigger class="w-60">
                                            {settings.settings.dpriceMode === "integrated" ? "Integrated (app-managed DB)" : settings.settings.dpriceMode === "local" ? "Local (shared CLI DB)" : "HTTP API (external server)"}
                                        </Select.Trigger>
                                        <Select.Content>
                                            <Select.Item value="integrated">Integrated (app-managed DB)</Select.Item>
                                            <Select.Item value="local">Local (shared CLI DB)</Select.Item>
                                            <Select.Item value="http">HTTP API (external server)</Select.Item>
                                        </Select.Content>
                                    </Select.Root>
                                    <p class="text-xs text-muted-foreground">
                                        {#if settings.settings.dpriceMode === "integrated"}
                                            Uses a co-located database managed
                                            by the app.
                                        {:else if settings.settings.dpriceMode === "local"}
                                            Shares the database with the <code
                                                >dprice</code
                                            > CLI tool.
                                        {:else if settings.settings.dpriceMode === "http"}
                                            Connects to an external <code
                                                >dprice serve</code
                                            > instance.
                                        {/if}
                                    </p>
                                </div>
                            {:else}
                                <p class="text-xs text-muted-foreground">
                                    Using HTTP API mode. Configure the server
                                    URL below.
                                </p>
                            {/if}
                            {#if settings.settings.dpriceMode === "http"}
                                <div class="space-y-2">
                                    <label
                                        for="dprice-url"
                                        class="text-sm font-medium"
                                        >Server URL</label
                                    >
                                    <Input
                                        id="dprice-url"
                                        value={settings.settings.dpriceUrl ??
                                            "http://localhost:3080"}
                                        oninput={(e) =>
                                            settings.update({
                                                dpriceUrl:
                                                    (
                                                        e.target as HTMLInputElement
                                                    ).value || undefined,
                                            })}
                                        placeholder="http://localhost:3080"
                                        class="w-80"
                                    />
                                </div>
                            {/if}
                            {#if settings.settings.dpriceMode === "local" && dpriceLocalPath}
                                <div class="rounded-md border bg-muted/50 p-3">
                                    <p class="text-xs text-muted-foreground">
                                        Database path: <code
                                            >{dpriceLocalPath}</code
                                        >
                                    </p>
                                </div>
                            {/if}
                            <div class="space-y-2">
                                {#if dpriceLoading}
                                    <p class="text-sm text-muted-foreground">
                                        Loading status...
                                    </p>
                                {:else if dpriceHealth}
                                    <p class="text-sm">
                                        <span class="font-medium">Status:</span>
                                        {dpriceHealth.assets.toLocaleString()} assets,
                                        {dpriceHealth.prices.toLocaleString()} prices
                                    </p>
                                    {#if dpriceLatest}
                                        {@const days = dpriceStaleDays()}
                                        {#if days !== null && days > 2}
                                            <p
                                                class="text-sm text-amber-600 dark:text-amber-400"
                                            >
                                                Data is stale (last update: {dpriceLatest},
                                                {days} days ago)
                                            </p>
                                        {:else}
                                            <p
                                                class="text-sm text-muted-foreground"
                                            >
                                                Last updated: {dpriceLatest}{days !==
                                                null
                                                    ? ` (${days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`})`
                                                    : ""}
                                            </p>
                                        {/if}
                                    {:else}
                                        <p
                                            class="text-sm text-muted-foreground"
                                        >
                                            No price data yet. Run a sync to
                                            populate.
                                        </p>
                                    {/if}
                                {:else}
                                    <p class="text-sm text-muted-foreground">
                                        Could not load dprice status. Is the
                                        database accessible?
                                    </p>
                                {/if}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={testResults.dprice?.status === 'testing'}
                                    onclick={() => handleTest('dprice', () => testDprice(() => dpriceClient().health()))}
                                >
                                    {testResults.dprice?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                                {#if testResults.dprice?.status === 'success'}
                                    <span class="text-xs text-green-600 dark:text-green-400">{testResults.dprice.message ?? 'OK'}</span>
                                {:else if testResults.dprice?.status === 'error'}
                                    <span class="text-xs text-destructive">{testResults.dprice.message}</span>
                                {/if}
                            </div>
                            {#if settings.settings.dpriceMode === "integrated"}
                                <div class="flex flex-wrap items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={taskQueue.isActive(
                                            "dprice-sync-latest",
                                        ) ||
                                            taskQueue.isActive(
                                                "dprice-sync-full",
                                            )}
                                        onclick={handleDpriceSyncLatest}
                                    >
                                        {taskQueue.isActive(
                                            "dprice-sync-latest",
                                        )
                                            ? "Syncing..."
                                            : "Sync Latest"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={taskQueue.isActive(
                                            "dprice-sync-latest",
                                        ) ||
                                            taskQueue.isActive(
                                                "dprice-sync-full",
                                            )}
                                        onclick={handleDpriceSyncFull}
                                    >
                                        {taskQueue.isActive("dprice-sync-full")
                                            ? "Syncing..."
                                            : "Full Sync"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={dpriceExporting}
                                        onclick={handleDpriceExport}
                                    >
                                        {dpriceExporting
                                            ? "Exporting..."
                                            : "Export DB"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={dpriceImporting}
                                        onclick={handleDpriceImport}
                                    >
                                        {dpriceImporting
                                            ? "Importing..."
                                            : "Import DB"}
                                    </Button>
                                </div>
                            {/if}
                        {/if}
                    </div>
                </Tabs.Content>

                <Tabs.Content value="fiat" class="space-y-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Frankfurter</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.frankfurterEnabled !== false}
                                onCheckedChange={(c) => settings.update({ frankfurterEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.frankfurterEnabled === false}
                         class:pointer-events-none={settings.settings.frankfurterEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                Fiat exchange rates (no key required)
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.frankfurter?.status === 'testing'}
                                onclick={() => handleTest('frankfurter', testFrankfurter)}>
                                {testResults.frankfurter?.status === 'testing' ? 'Testing...' : 'Test'}
                            </Button>
                            {#if testResults.frankfurter?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.frankfurter.message ?? 'OK'}</span>
                            {:else if testResults.frankfurter?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.frankfurter.message}</span>
                            {/if}
                        </div>
                    </div>
                </Tabs.Content>

                <Tabs.Content value="stock" class="space-y-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Finnhub</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.finnhubEnabled !== false}
                                onCheckedChange={(c) => settings.update({ finnhubEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.finnhubEnabled === false}
                         class:pointer-events-none={settings.settings.finnhubEnabled === false}>
                        <div class="space-y-2">
                            <label for="finnhub-api-key" class="text-sm font-medium"
                                >Finnhub API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="finnhub-api-key"
                                    type="password"
                                    placeholder="Finnhub API key (optional)"
                                    value={settings.finnhubApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            finnhubApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.finnhub?.status === 'testing'}
                                    onclick={() => handleTest('finnhub', () => testFinnhub(settings.finnhubApiKey))}>
                                    {testResults.finnhub?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            {#if testResults.finnhub?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.finnhub.message ?? 'OK'}</span>
                            {:else if testResults.finnhub?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.finnhub.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                Get a free key at <a
                                    href="https://finnhub.io"
                                    target="_blank"
                                    class="underline hover:text-foreground"
                                    >finnhub.io</a
                                >. Required for stock prices (AAPL, GOOG, etc.).
                            </p>
                        </div>
                    </div>
                </Tabs.Content>

                <Tabs.Content value="crypto" class="space-y-4">
                    <!-- CoinGecko -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">CoinGecko</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.coingeckoEnabled !== false}
                                onCheckedChange={(c) => settings.update({ coingeckoEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.coingeckoEnabled === false}
                         class:pointer-events-none={settings.settings.coingeckoEnabled === false}>
                        <div class="space-y-2">
                            <label
                                for="coingecko-api-key"
                                class="text-sm font-medium">CoinGecko API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="coingecko-api-key"
                                    type="password"
                                    placeholder={settings.settings.coingeckoPro ? "CoinGecko Pro API key" : "CoinGecko demo API key (optional)"}
                                    value={settings.coingeckoApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            coingeckoApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.coingecko?.status === 'testing'}
                                    onclick={() => handleTest('coingecko', () => testCoinGecko(settings.coingeckoApiKey, settings.settings.coingeckoPro))}>
                                    {testResults.coingecko?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            <div class="flex items-center gap-2">
                                <Switch
                                    id="coingecko-pro"
                                    checked={settings.settings.coingeckoPro ?? false}
                                    onCheckedChange={(checked) => settings.update({ coingeckoPro: checked })}
                                />
                                <label for="coingecko-pro" class="text-sm">Pro API</label>
                            </div>
                            {#if testResults.coingecko?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.coingecko.message ?? 'OK'}</span>
                            {:else if testResults.coingecko?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.coingecko.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {#if settings.settings.coingeckoPro}
                                    Using Pro endpoint (<a
                                        href="https://www.coingecko.com/en/api/pricing"
                                        target="_blank"
                                        class="underline hover:text-foreground"
                                        >pro-api.coingecko.com</a
                                    >). 500 req/min.
                                {:else}
                                    Get a free demo key at <a
                                        href="https://www.coingecko.com/en/api"
                                        target="_blank"
                                        class="underline hover:text-foreground"
                                        >coingecko.com</a
                                    >. Required for crypto rates. Fiat rates work
                                    without a key.
                                {/if}
                            </p>
                        </div>
                    </div>

                    <Separator />

                    <!-- CryptoCompare -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">CryptoCompare</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.cryptoCompareEnabled !== false}
                                onCheckedChange={(c) => settings.update({ cryptoCompareEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.cryptoCompareEnabled === false}
                         class:pointer-events-none={settings.settings.cryptoCompareEnabled === false}>
                        <div class="space-y-2">
                            <label
                                for="cryptocompare-api-key"
                                class="text-sm font-medium"
                                >CryptoCompare API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="cryptocompare-api-key"
                                    type="password"
                                    placeholder="CryptoCompare API key (optional)"
                                    value={settings.cryptoCompareApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            cryptoCompareApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.cryptocompare?.status === 'testing'}
                                    onclick={() => handleTest('cryptocompare', () => testCryptoCompare(settings.cryptoCompareApiKey))}>
                                    {testResults.cryptocompare?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            {#if testResults.cryptocompare?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.cryptocompare.message ?? 'OK'}</span>
                            {:else if testResults.cryptocompare?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.cryptocompare.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                Get a free key at <a
                                    href="https://www.cryptocompare.com/cryptopian/api-keys"
                                    target="_blank"
                                    class="underline hover:text-foreground"
                                    >cryptocompare.com</a
                                >. Optional fallback for crypto historical rates.
                            </p>
                        </div>
                    </div>

                    <Separator />

                    <!-- DefiLlama -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">DefiLlama</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.defillamaEnabled !== false}
                                onCheckedChange={(c) => settings.update({ defillamaEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.defillamaEnabled === false}
                         class:pointer-events-none={settings.settings.defillamaEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                Default crypto rate source (no key required)
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.defillama?.status === 'testing'}
                                onclick={() => handleTest('defillama', testDefiLlama)}>
                                {testResults.defillama?.status === 'testing' ? 'Testing...' : 'Test'}
                            </Button>
                            {#if testResults.defillama?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.defillama.message ?? 'OK'}</span>
                            {:else if testResults.defillama?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.defillama.message}</span>
                            {/if}
                        </div>
                    </div>

                    <Separator />

                    <!-- Binance -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Binance</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.binanceRatesEnabled !== false}
                                onCheckedChange={(c) => settings.update({ binanceRatesEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.binanceRatesEnabled === false}
                         class:pointer-events-none={settings.settings.binanceRatesEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                Crypto rates via public API (no key required)
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.binance?.status === 'testing'}
                                onclick={() => handleTest('binance', testBinance)}>
                                {testResults.binance?.status === 'testing' ? 'Testing...' : 'Test'}
                            </Button>
                            {#if testResults.binance?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.binance.message ?? 'OK'}</span>
                            {:else if testResults.binance?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.binance.message}</span>
                            {/if}
                        </div>
                    </div>

                    <Separator />

                    <!-- Etherscan -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Etherscan</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.etherscanEnabled !== false}
                                onCheckedChange={(c) => settings.update({ etherscanEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.etherscanEnabled === false}
                         class:pointer-events-none={settings.settings.etherscanEnabled === false}>
                        <div class="space-y-2">
                            <label
                                for="etherscan-api-key"
                                class="text-sm font-medium">Etherscan API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="etherscan-api-key"
                                    type="password"
                                    placeholder="Etherscan API key"
                                    value={settings.etherscanApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            etherscanApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.etherscan?.status === 'testing'}
                                    onclick={() => handleTest('etherscan', () => testEtherscan(settings.etherscanApiKey))}>
                                    {testResults.etherscan?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            {#if testResults.etherscan?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.etherscan.message ?? 'OK'}</span>
                            {:else if testResults.etherscan?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.etherscan.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                Get a free API key at <a
                                    href="https://etherscan.io/apis"
                                    target="_blank"
                                    class="underline hover:text-foreground"
                                    >etherscan.io</a
                                >. One key works for most EVM chains.
                            </p>
                        </div>
                    </div>

                    <Separator />

                    <!-- Routescan -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Routescan</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.routescanEnabled !== false}
                                onCheckedChange={(c) => settings.update({ routescanEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.routescanEnabled === false}
                         class:pointer-events-none={settings.settings.routescanEnabled === false}>
                        <div class="space-y-2">
                            <label
                                for="routescan-api-key"
                                class="text-sm font-medium"
                                >Routescan API Key (optional)</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="routescan-api-key"
                                    type="password"
                                    placeholder="Routescan API key"
                                    value={settings.settings.routescanApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            routescanApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.routescan?.status === 'testing'}
                                    onclick={() => handleTest('routescan', () => testRoutescan(settings.settings.routescanApiKey || undefined))}>
                                    {testResults.routescan?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            {#if testResults.routescan?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.routescan.message ?? 'OK'}</span>
                            {:else if testResults.routescan?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.routescan.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                Used for BSC, Base, Optimism, and Avalanche (free at <a
                                    href="https://routescan.io"
                                    target="_blank"
                                    class="underline hover:text-foreground"
                                    >routescan.io</a
                                >). Leave blank for keyless access (slower rate
                                limit).
                            </p>
                        </div>
                    </div>

                    <Separator />

                    <!-- The Graph -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">The Graph</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.theGraphEnabled !== false}
                                onCheckedChange={(c) => settings.update({ theGraphEnabled: c })} />
                            <label class="text-sm text-muted-foreground">Enabled</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.theGraphEnabled === false}
                         class:pointer-events-none={settings.settings.theGraphEnabled === false}>
                        <div class="space-y-2">
                            <label
                                for="thegraph-api-key"
                                class="text-sm font-medium">The Graph API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="thegraph-api-key"
                                    type="password"
                                    placeholder="The Graph API key (optional)"
                                    value={settings.theGraphApiKey}
                                    oninput={(e) =>
                                        settings.update({
                                            theGraphApiKey: (
                                                e.target as HTMLInputElement
                                            ).value,
                                        })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.thegraph?.status === 'testing'}
                                    onclick={() => handleTest('thegraph', () => testTheGraph(settings.theGraphApiKey))}>
                                    {testResults.thegraph?.status === 'testing' ? 'Testing...' : 'Test'}
                                </Button>
                            </div>
                            {#if testResults.thegraph?.status === 'success'}
                                <span class="text-xs text-green-600 dark:text-green-400">{testResults.thegraph.message ?? 'OK'}</span>
                            {:else if testResults.thegraph?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.thegraph.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                Get a free key at <a
                                    href="https://thegraph.com/studio/apikeys/"
                                    target="_blank"
                                    class="underline hover:text-foreground"
                                    >thegraph.com/studio</a
                                >. Required for Uniswap pool enrichment.
                            </p>
                        </div>
                    </div>
                </Tabs.Content>
            </Tabs.Root>
        </Card.Content>
    </Card.Root>

    <!-- Account Paths -->
    <Card.Root>
        <Card.Header>
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <Card.Title>Account Paths</Card.Title>
                    <Card.Description
                        >Customize the account paths used by future imports.
                        Existing accounts are not automatically renamed.</Card.Description
                    >
                </div>
                <div class="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={countAffectedAccounts}
                        disabled={pathRenaming}
                    >
                        Check Existing
                    </Button>
                    {#if renameCounts.size > 0}
                        <Button
                            variant="default"
                            size="sm"
                            onclick={handleRenameAll}
                            disabled={pathRenaming}
                        >
                            {pathRenaming
                                ? "Renaming..."
                                : `Rename ${[...renameCounts.values()].reduce((a, b) => a + b, 0)} accounts`}
                        </Button>
                    {/if}
                </div>
            </div>
        </Card.Header>
        <Card.Content class="space-y-4">
            {#each PATH_SECTIONS as section}
                <Collapsible.Root>
                    <div class="flex items-center justify-between">
                        <Collapsible.Trigger
                            class="flex items-center gap-2 text-sm font-medium hover:underline"
                        >
                            <span
                                class="i-lucide-chevron-right h-4 w-4 transition-transform [[data-state=open]>&]:rotate-90"
                                >&#9654;</span
                            >
                            {section.title}
                        </Collapsible.Trigger>
                        <Button
                            variant="ghost"
                            size="sm"
                            onclick={() =>
                                resetPathSection(
                                    section.keys.map((k) => k.key),
                                )}
                        >
                            Reset
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground mb-2">
                        {section.description}
                    </p>
                    <Collapsible.Content>
                        <div class="space-y-3 pl-2">
                            {#each section.keys as { key, label, example }}
                                {@const err = pathErrors(key)}
                                {@const value = getPathValue(key)}
                                {@const isDefault =
                                    value === DEFAULT_PATH_CONFIG[key]}
                                <div class="space-y-1">
                                    <div class="flex items-center gap-2">
                                        <label
                                            for="path-{key}"
                                            class="text-xs text-muted-foreground w-36 shrink-0"
                                            >{label}</label
                                        >
                                        <Input
                                            id="path-{key}"
                                            {value}
                                            oninput={(e) =>
                                                handlePathChange(
                                                    key,
                                                    (
                                                        e.target as HTMLInputElement
                                                    ).value,
                                                )}
                                            class="font-mono text-xs {err
                                                ? 'border-destructive'
                                                : ''} {!isDefault
                                                ? 'border-primary'
                                                : ''}"
                                        />
                                    </div>
                                    <div class="flex items-center gap-2 pl-38">
                                        <span
                                            class="text-xs text-muted-foreground font-mono"
                                            >{value}:{example}</span
                                        >
                                        {#if err}
                                            <span
                                                class="text-xs text-destructive"
                                                >{err}</span
                                            >
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
            <Card.Description
                >Create a starter chart of accounts. Existing accounts are
                preserved.</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <Select.Root type="single" bind:value={defaultSet}>
                        <Select.Trigger>
                            {defaultSet === "minimal" ? "Minimal (~25)" : defaultSet === "standard" ? "Standard (~45)" : "Comprehensive (~65)"}
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="minimal">Minimal (~25)</Select.Item>
                            <Select.Item value="standard">Standard (~45)</Select.Item>
                            <Select.Item value="comprehensive">Comprehensive (~65)</Select.Item>
                        </Select.Content>
                    </Select.Root>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onclick={handleCreateDefaults}
                    disabled={creatingDefaults}
                >
                    {creatingDefaults ? "Creating..." : "Create Accounts"}
                </Button>
            </div>
        </Card.Content>
    </Card.Root>

    <!-- Data Management -->
    <Card.Root>
        <Card.Header>
            <Card.Title>Data Management</Card.Title>
            <Card.Description
                >Clear stored data. These actions cannot be undone.</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">Clear Exchange Rates</p>
                    <p class="text-sm text-muted-foreground">
                        Remove all synced and manual exchange rates.
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearExchangeRates}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-exchange-rates")
                        ? "Clearing..."
                        : "Clear Rates"}
                </Button>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">Clear Ledger Data</p>
                    <p class="text-sm text-muted-foreground">
                        Remove all accounts, transactions, and currencies.
                        Exchange rates, sources, and settings are preserved.
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearLedgerData}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-ledger-data")
                        ? "Clearing..."
                        : "Clear Ledger"}
                </Button>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">Clear All Data</p>
                    <p class="text-sm text-muted-foreground">
                        Delete all accounts, transactions, currencies, exchange
                        rates, and reset settings.
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearAllData}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-all-data")
                        ? "Clearing..."
                        : "Clear All Data"}
                </Button>
            </div>
        </Card.Content>
    </Card.Root>

    {#if import.meta.env.DEV}
        <Card.Root>
            <Card.Header>
                <Card.Title>Development</Card.Title>
                <Card.Description
                    >Debug tools (only visible in dev mode).</Card.Description
                >
            </Card.Header>
            <Card.Content>
                <label class="flex items-center gap-2 text-sm">
                    <Switch
                        checked={settings.debugMode}
                        onCheckedChange={(v) =>
                            settings.update({ debugMode: v })}
                    />
                    Debug Mode
                </label>
            </Card.Content>
        </Card.Root>
    {/if}
</div>
