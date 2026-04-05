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
    import { mode, setMode } from "mode-watcher";
    import * as Select from "$lib/components/ui/select/index.js";
    import ListFilter from "$lib/components/ListFilter.svelte";
    import { getFiatFlagUrl, clearIconCache } from "$lib/data/coin-icons.svelte.js";
    import { COMMON_CURRENCIES } from "$lib/data/common-currencies.js";
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
        testHelius,
        testDprice,
        type TestResult,
    } from "$lib/service-test.js";
    import * as msg from "$paraglide/messages.js";
    import { setLocale } from "$paraglide/runtime.js";
    import type { Locale } from "$paraglide/runtime.js";
    import Download from "lucide-svelte/icons/download";
    import Upload from "lucide-svelte/icons/upload";
    import Trash2 from "lucide-svelte/icons/trash-2";
    import Puzzle from "lucide-svelte/icons/puzzle";
    import type { CustomPluginRecord } from "$lib/plugins/custom-plugins.js";
    import { loadPluginFromCode } from "$lib/feedback/plugin-loader.js";
    import { saveCustomPlugin } from "$lib/plugins/custom-plugins.js";
    import Plus from "lucide-svelte/icons/plus";
    import Code from "lucide-svelte/icons/code";
    import Copy from "lucide-svelte/icons/copy";
    import Check from "lucide-svelte/icons/check";
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import { AlertDialog } from "bits-ui";
    import ExportDialog from "$lib/components/ExportDialog.svelte";
    import DledgerImportDialog from "$lib/components/DledgerImportDialog.svelte";
    const settings = new SettingsStore();

    // Export/Import dialog state
    let exportDialogOpen = $state(false);
    let importDialogOpen = $state(false);

    // Custom plugins state
    let customPlugins = $state<CustomPluginRecord[]>([]);

    async function loadCustomPlugins() {
        try {
            customPlugins = await getBackend().listCustomPlugins();
        } catch (e) {
            console.error("Failed to load custom plugins:", e);
        }
    }

    async function togglePluginEnabled(plugin: CustomPluginRecord) {
        try {
            await getBackend().setCustomPluginEnabled(plugin.id, !plugin.enabled);
            await loadCustomPlugins();
            toast.success(
                !plugin.enabled
                    ? msg.settings_plugins_enabled()
                    : msg.settings_plugins_disabled(),
            );
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        }
    }

    async function deletePlugin(plugin: CustomPluginRecord) {
        if (!window.confirm(msg.settings_plugins_delete_confirm({ name: plugin.name }))) return;
        try {
            await getBackend().deleteCustomPlugin(plugin.id);
            await loadCustomPlugins();
            toast.success(`Deleted plugin "${plugin.name}"`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        }
    }

    let addPluginDialogOpen = $state(false);
    let addPluginCode = $state("");
    let addPluginError = $state("");
    let pluginFileInput: HTMLInputElement | undefined = $state();

    let viewCodeDialogOpen = $state(false);
    let viewCodePlugin = $state<CustomPluginRecord | null>(null);
    let viewCodeCopied = $state(false);
    let viewCodeHtml = $state("");

    function showPluginCode(plugin: CustomPluginRecord) {
        viewCodePlugin = plugin;
        viewCodeCopied = false;
        viewCodeHtml = "";
        viewCodeDialogOpen = true;
    }

    $effect(() => {
        if (viewCodeDialogOpen && viewCodePlugin) {
            const code = viewCodePlugin.source_code;
            import("shiki/bundle/web").then(({ codeToHtml }) => {
                const isDark = document.documentElement.classList.contains("dark");
                codeToHtml(code, {
                    lang: "javascript",
                    theme: isDark ? "github-dark" : "github-light",
                }).then((html) => { viewCodeHtml = html; });
            });
        }
    });

    async function copyPluginCode() {
        if (!viewCodePlugin) return;
        await navigator.clipboard.writeText(viewCodePlugin.source_code);
        viewCodeCopied = true;
        setTimeout(() => { viewCodeCopied = false; }, 2000);
    }

    function handlePluginFileLoad() {
        const file = pluginFileInput?.files?.[0];
        if (!file) return;
        file.text().then((text) => { addPluginCode = text; });
        if (pluginFileInput) pluginFileInput.value = "";
    }

    async function handleAddPlugin() {
        addPluginError = "";
        const result = loadPluginFromCode(addPluginCode);
        if (!result.success) {
            addPluginError = result.error ?? "Unknown error";
            return;
        }
        try {
            await saveCustomPlugin(getBackend(), result.plugin!, addPluginCode);
            await loadCustomPlugins();
            toast.success(msg.feedback_load_success({ name: result.plugin!.name }));
            addPluginDialogOpen = false;
            addPluginCode = "";
        } catch (e) {
            addPluginError = e instanceof Error ? e.message : String(e);
        }
    }

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
                    msg.toast_accounts_renamed({ count: totalRenamed, skipped: totalSkipped > 0 ? ` (${totalSkipped} skipped)` : "" }),
                );
            } else {
                toast.info(msg.toast_no_accounts_renamed());
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
            title: msg.settings_path_banking(),
            description: msg.settings_path_banking_desc(),
            keys: [
                { key: "bankAssets", label: msg.settings_path_bank_assets(), example: "MyBank" },
                { key: "bankFees", label: msg.settings_path_bank_fees(), example: "MyBank" },
                { key: "creditCards", label: msg.settings_path_credit_cards(), example: "1234" },
            ],
        },
        {
            title: msg.settings_path_exchange(),
            description: msg.settings_path_exchange_desc(),
            keys: [
                {
                    key: "exchangeAssets",
                    label: msg.settings_path_exchange_assets(),
                    example: "Kraken",
                },
                {
                    key: "exchangeFees",
                    label: msg.settings_path_exchange_fees(),
                    example: "Kraken",
                },
                {
                    key: "exchangeEquity",
                    label: msg.settings_path_exchange_equity(),
                    example: "Kraken",
                },
                {
                    key: "exchangeStaking",
                    label: msg.settings_path_exchange_staking(),
                    example: "Kraken",
                },
                {
                    key: "exchangeIncome",
                    label: msg.settings_path_exchange_income(),
                    example: "Nexo",
                },
                {
                    key: "exchangeExpenses",
                    label: msg.settings_path_exchange_expenses(),
                    example: "CryptoCom",
                },
            ],
        },
        {
            title: msg.settings_path_wallet(),
            description: msg.settings_path_wallet_desc(),
            keys: [
                {
                    key: "walletAssets",
                    label: msg.settings_path_wallet_assets(),
                    example: "Ethereum:Main",
                },
                {
                    key: "walletEquity",
                    label: msg.settings_path_wallet_equity(),
                    example: "Ethereum",
                },
                { key: "chainFees", label: msg.settings_path_chain_fees(), example: "Ethereum" },
            ],
        },
        {
            title: msg.settings_path_defi(),
            description: msg.settings_path_defi_desc(),
            keys: [
                {
                    key: "defiAssets",
                    label: msg.settings_path_defi_assets(),
                    example: "Aave:Supply",
                },
                {
                    key: "defiLiabilities",
                    label: msg.settings_path_defi_liabilities(),
                    example: "Aave:Borrow",
                },
                {
                    key: "defiIncome",
                    label: msg.settings_path_defi_income(),
                    example: "Aave:Interest",
                },
                {
                    key: "defiExpenses",
                    label: msg.settings_path_defi_expenses(),
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

    // Merge backend currencies with common fiat currencies for base currency selector
    const baseCurrencyOptions = $derived.by(() => {
        const seen = new Set<string>();
        const result: { code: string; name: string }[] = [];
        // Common currencies first (stable order)
        for (const c of COMMON_CURRENCIES) {
            seen.add(c.code);
            const fromDb = currencies.find((db) => db.code === c.code);
            result.push({ code: c.code, name: fromDb?.name || c.name });
        }
        // Then any additional currencies from DB
        for (const c of currencies) {
            if (!seen.has(c.code)) {
                seen.add(c.code);
                result.push({ code: c.code, name: c.name });
            }
        }
        return result;
    });

    // Currency asset type override state
    const ASSET_TYPES: { value: CurrencyAssetType; label: string }[] = [
        { value: "", label: msg.asset_type_unclassified() },
        { value: "fiat", label: msg.asset_type_fiat() },
        { value: "crypto", label: msg.asset_type_crypto() },
        { value: "stock", label: msg.asset_type_stock() },
        { value: "commodity", label: msg.asset_type_commodity() },
        { value: "index", label: msg.asset_type_index() },
        { value: "bond", label: msg.asset_type_bond() },
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
            toast.success(msg.toast_asset_type_overrides_saved());
        } catch (err) {
            toast.error(msg.toast_error_generic({ message: String(err) }));
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
        msg.month_january(),
        msg.month_february(),
        msg.month_march(),
        msg.month_april(),
        msg.month_may(),
        msg.month_june(),
        msg.month_july(),
        msg.month_august(),
        msg.month_september(),
        msg.month_october(),
        msg.month_november(),
        msg.month_december(),
    ];

    async function loadCurrencies() {
        try {
            currencies = await getBackend().listCurrencies();
        } catch {
            currencies = [];
        }
    }

    let pendingCurrency = $state("");
    let confirmCurrencyOpen = $state(false);
    let currencySelectKey = $state(0);

    function handleCurrencyChange(val: string) {
        // If the currency already exists in the database, just switch — no confirmation needed
        if (currencies.some((c) => c.code === val)) {
            settings.update({ currency: val });
            return;
        }
        pendingCurrency = val;
        confirmCurrencyOpen = true;
    }

    function cancelCurrencyChange() {
        confirmCurrencyOpen = false;
        // Force Select to re-render with the original value
        currencySelectKey++;
    }

    async function applyBaseCurrencyChange() {
        confirmCurrencyOpen = false;
        const val = pendingCurrency;
        settings.update({ currency: val });
        try {
            const name = COMMON_CURRENCIES.find((c) => c.code === val)?.name ?? val;
            await getBackend().createCurrency({
                code: val,
                asset_type: "fiat",
                name,
                decimal_places: 2,
            });
        } catch {
            // Already exists — expected
        }
        await loadCurrencies();
        invalidate("currencies");
    }

    function handleDateFormatChange(val: string) {
        settings.update({ dateFormat: val });
    }

    function handleFiscalYearChange(val: string) {
        const month = parseInt(val, 10);
        const mm = String(month).padStart(2, "0");
        settings.update({ fiscalYearStart: `${mm}-01` });
    }

    const localeOptions = [
        { value: "auto", label: `Auto (${typeof navigator !== "undefined" ? navigator.language : "en-US"})` },
        { value: "en-US", label: "English (US)" },
        { value: "en-GB", label: "English (UK)" },
        { value: "fr-FR", label: "Français" },
        { value: "de-DE", label: "Deutsch" },
        { value: "es-ES", label: "Español" },
        { value: "it-IT", label: "Italiano" },
        { value: "pt-BR", label: "Português (BR)" },
        { value: "ja-JP", label: "日本語" },
        { value: "zh-CN", label: "中文 (简体)" },
        { value: "ko-KR", label: "한국어" },
    ];

    const currentLocaleValue = $derived(settings.settings.locale ?? "auto");

    function handleLocaleChange(val: string) {
        settings.update({ locale: val === "auto" ? undefined : val });
    }

    const languageOptions = [
        { value: "en", label: "English" },
        { value: "fr", label: "Français" },
    ];

    const currentLanguage = $derived.by(() => {
        const locale = settings.settings.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
        return locale.startsWith("fr") ? "fr" : "en";
    });

    function handleLanguageChange(val: string) {
        // Store full locale if switching to French, otherwise English
        const newLocale = val === "fr" ? "fr-FR" : "en-US";
        settings.update({ locale: newLocale });
        setLocale(val as Locale);
    }

    const clearing = $derived(
        taskQueue.isActive("clear-exchange-rates") ||
            taskQueue.isActive("clear-ledger-data") ||
            taskQueue.isActive("clear-all-data"),
    );

    function handleClearExchangeRates() {
        if (
            !window.confirm(msg.confirm_clear_exchange_rates())
        )
            return;
        taskQueue.enqueue({
            key: "clear-exchange-rates",
            label: msg.settings_clear_exchange_rates(),
            async run() {
                await getBackend().clearExchangeRates();
                await getBackend().clearAllRateFetchFailures();
                invalidate("currencies");
                toast.success(msg.toast_exchange_rates_cleared());
                return { summary: "Exchange rates cleared" };
            },
        });
    }

    function handleClearLedgerData() {
        if (
            !window.confirm(msg.confirm_clear_ledger_data()
            )
        )
            return;
        taskQueue.enqueue({
            key: "clear-ledger-data",
            label: msg.settings_clear_ledger_data(),
            async run() {
                await getBackend().clearLedgerData();
                await clearIconCache();
                await reloadHiddenCurrencies(getBackend());
                currencies = [];
                invalidate("currencies");
                toast.success(msg.toast_ledger_data_cleared());
                return { summary: "Ledger data cleared" };
            },
        });
    }

    function handleClearAllData() {
        if (
            !window.confirm(msg.confirm_clear_all_data())
        )
            return;
        taskQueue.enqueue({
            key: "clear-all-data",
            label: msg.settings_clear_all_data(),
            async run() {
                await getBackend().clearAllData();
                await clearIconCache();
                settings.reset();
                currencies = [];
                invalidate("currencies");
                toast.success(msg.toast_all_data_cleared());
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
                toast.success(msg.toast_accounts_created_count({ count: result.created }));
            } else {
                toast.info(msg.toast_accounts_exist());
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
            dpriceApiKey: settings.settings.dpriceApiKey,
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
            label: msg.settings_dprice_sync_latest_task(),
            async run() {
                await dpriceClient().syncLatest();
                await loadDpriceStatus();
                toast.success(msg.toast_dprice_latest_synced());
                return { summary: "dprice latest synced" };
            },
        });
    }

    function handleDpriceSyncFull() {
        taskQueue.enqueue({
            key: "dprice-sync-full",
            label: msg.settings_dprice_full_sync_task(),
            async run() {
                await dpriceClient().sync();
                await loadDpriceStatus();
                toast.success(msg.toast_dprice_full_synced());
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
            toast.success(msg.toast_dprice_exported());
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
                !window.confirm(msg.confirm_import_dprice({ name: file.name }))
            )
                return;
            dpriceImporting = true;
            try {
                const data = await readFileAsUint8Array(file);
                await dpriceClient().importDb(data);
                toast.success(msg.toast_dprice_imported());
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
                    msg.toast_dprice_mode_failed({ message: e instanceof Error ? e.message : String(e) }),
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
        loadCustomPlugins();
    });
</script>

<div class="space-y-6">
    <!-- General -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{msg.settings_general()}</Card.Title>
            <Card.Description
                >{msg.settings_general_desc()}</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="space-y-2">
                    <span class="text-sm font-medium">{msg.settings_base_currency()}</span>
                    {#key currencySelectKey}<Select.Root type="single" value={settings.currency} onValueChange={handleCurrencyChange}>
                        <Select.Trigger class="w-full">
                            {@const cur = baseCurrencyOptions.find((c) => c.code === settings.currency)}
                            {@const flagUrl = getFiatFlagUrl(settings.currency)}
                            <span class="inline-flex items-center gap-2">
                                {#if flagUrl}<img src={flagUrl} alt="" class="size-4 rounded-full" />{/if}
                                {cur ? `${cur.code} — ${cur.name}` : settings.currency}
                            </span>
                        </Select.Trigger>
                        <Select.Content>
                            {#each baseCurrencyOptions as c (c.code)}
                                {@const flagUrl = getFiatFlagUrl(c.code)}
                                <Select.Item value={c.code}>
                                    <span class="inline-flex items-center gap-2">
                                        {#if flagUrl}<img src={flagUrl} alt="" class="size-4 rounded-full" />{/if}
                                        {c.code} — {c.name}
                                    </span>
                                </Select.Item>
                            {/each}
                        </Select.Content>
                    </Select.Root>{/key}
                </div>

                <div class="space-y-2">
                    <span class="text-sm font-medium">{msg.settings_date_format()}</span>
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
                    <span class="text-sm font-medium">{msg.settings_number_format()}</span>
                    <Select.Root type="single" value={currentLocaleValue} onValueChange={handleLocaleChange}>
                        <Select.Trigger class="w-full">
                            {localeOptions.find((l) => l.value === currentLocaleValue)?.label ?? currentLocaleValue}
                        </Select.Trigger>
                        <Select.Content>
                            {#each localeOptions as lo (lo.value)}
                                <Select.Item value={lo.value}>{lo.label}</Select.Item>
                            {/each}
                        </Select.Content>
                    </Select.Root>
                </div>

                <div class="space-y-2">
                    <span class="text-sm font-medium">{msg.settings_language()}</span>
                    <Select.Root type="single" value={currentLanguage} onValueChange={handleLanguageChange}>
                        <Select.Trigger class="w-full">
                            {languageOptions.find((l) => l.value === currentLanguage)?.label ?? currentLanguage}
                        </Select.Trigger>
                        <Select.Content>
                            {#each languageOptions as lang (lang.value)}
                                <Select.Item value={lang.value}>{lang.label}</Select.Item>
                            {/each}
                        </Select.Content>
                    </Select.Root>
                    <p class="text-xs text-muted-foreground">{msg.settings_language_description()}</p>
                </div>

                <div class="space-y-2">
                    <span class="text-sm font-medium">{msg.settings_fiscal_year_start()}</span>
                    <Select.Root type="single" value={String(parseInt(settings.fiscalYearStart.split("-")[0], 10))} onValueChange={handleFiscalYearChange}>
                        <Select.Trigger class="w-full">
                            {months[parseInt(settings.fiscalYearStart.split("-")[0], 10) - 1] ?? msg.month_january()}
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
                {msg.settings_manage_currencies_prefix()}<a href="/currencies" class="underline">{msg.settings_currencies_link()}</a>{msg.settings_manage_currencies_suffix()}
            </p>
        </Card.Content>
    </Card.Root>

    <!-- Appearance -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{msg.settings_appearance()}</Card.Title>
            <Card.Description>{msg.settings_appearance_desc()}</Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_dark_mode()}</p>
                    <p class="text-sm text-muted-foreground">{msg.settings_dark_mode_desc()}</p>
                </div>
                <Switch checked={mode.current === "dark"}
                    onCheckedChange={(v) => setMode(v ? "dark" : "light")} />
            </div>
        </Card.Content>
    </Card.Root>

    <!-- ML Classification -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{msg.settings_ml_classification()}</Card.Title>
            <Card.Description
                >{msg.settings_ml_classification_desc()}</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">
                        {msg.settings_ml_enable()}
                    </p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_ml_enable_desc()}
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
                        {msg.settings_ml_confidence({ percent: String(Math.round(
                            (settings.settings.mlConfidenceThreshold ?? 0.5) *
                                100,
                        )) })}
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
                        {msg.settings_ml_confidence_desc()}
                    </p>
                </div>
                <Separator />
                <div class="space-y-2">
                    <p class="text-xs text-muted-foreground">
                        {msg.settings_ml_models_info()}
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
                                        ? msg.toast_cached_models_cleared()
                                        : msg.toast_no_cached_models(),
                                );
                            } catch {
                                toast.error(msg.toast_failed_clear_cache());
                            }
                        }}
                    >
                        {msg.settings_ml_clear_cache()}
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
                    <Card.Title>{msg.settings_currency_asset_types()}</Card.Title>
                    <Card.Description
                        >{msg.settings_currency_asset_types_desc()}</Card.Description
                    >
                </div>
                {#if currencies.filter((c) => !c.is_hidden).length > 0}
                    <Button variant="outline" size="sm" onclick={() => (assetTypesOpen = !assetTypesOpen)}>
                        {assetTypesOpen ? msg.btn_hide() : msg.btn_show()} ({currencies.filter((c) => !c.is_hidden).length}){#if assetTypeEdits.size > 0} &middot; {msg.settings_modified_count({ count: assetTypeEdits.size })}{/if}
                    </Button>
                {/if}
            </div>
        </Card.Header>
        {#if currencies.filter((c) => !c.is_hidden).length === 0}
            <Card.Content>
                <p class="text-muted-foreground text-sm">{msg.empty_no_currencies_found()}</p>
            </Card.Content>
        {:else if assetTypesOpen}
            <Card.Content class="space-y-3">
                <ListFilter bind:value={assetTypeSearch} placeholder={msg.placeholder_filter_currencies()} />
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
                                    {ASSET_TYPES.find((at) => at.value === currentType)?.label ?? msg.asset_type_unclassified()}
                                </Select.Trigger>
                                <Select.Content>
                                    {#each ASSET_TYPES as at (at.value)}
                                        <Select.Item value={at.value}>{at.label}</Select.Item>
                                    {/each}
                                </Select.Content>
                            </Select.Root>
                            {#if assetTypeEdits.has(cur.code)}
                                <span class="text-xs text-yellow-500">{msg.label_modified()}</span>
                            {/if}
                        </div>
                    {/each}
                    {#if visibleCurrencies.length === 0}
                        <p class="text-sm text-muted-foreground">{msg.empty_no_currencies_match({ search: assetTypeSearch })}</p>
                    {/if}
                </div>
                {#if assetTypeEdits.size > 0}
                    <div class="flex gap-2">
                        <Button size="sm" onclick={saveAssetTypeOverrides} disabled={savingAssetTypes}>
                            {savingAssetTypes ? msg.state_saving() : msg.settings_save_count({ count: assetTypeEdits.size })}
                        </Button>
                        <Button size="sm" variant="outline" onclick={() => (assetTypeEdits = new Map())}>
                            {msg.btn_discard()}
                        </Button>
                    </div>
                {/if}
            </Card.Content>
        {/if}
    </Card.Root>

    <!-- External Services -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{msg.settings_external_services()}</Card.Title>
            <Card.Description
                >{msg.settings_external_services_desc()}</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <Tabs.Root value="general">
                <Tabs.List>
                    <Tabs.Trigger value="general">{msg.settings_tab_general()}</Tabs.Trigger>
                    <Tabs.Trigger value="fiat">{msg.settings_tab_fiat()}</Tabs.Trigger>
                    <Tabs.Trigger value="stock">{msg.settings_tab_stocks()}</Tabs.Trigger>
                    <Tabs.Trigger value="crypto">{msg.settings_tab_crypto()}</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="general" class="space-y-4">
                    <div class="space-y-2">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-sm font-medium">
                                    {msg.settings_dprice()}
                                </p>
                                <p class="text-sm text-muted-foreground">
                                    {msg.settings_dprice_desc()}
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
                                    <span class="text-sm font-medium">{msg.settings_dprice_mode()}</span>
                                    <Select.Root type="single" value={settings.settings.dpriceMode} onValueChange={(val) => handleDpriceModeChange(val as DpriceMode)}>
                                        <Select.Trigger class="w-60">
                                            {settings.settings.dpriceMode === "integrated" ? msg.settings_dprice_integrated() : settings.settings.dpriceMode === "local" ? msg.settings_dprice_local() : msg.settings_dprice_http()}
                                        </Select.Trigger>
                                        <Select.Content>
                                            <Select.Item value="integrated">{msg.settings_dprice_integrated()}</Select.Item>
                                            <Select.Item value="local">{msg.settings_dprice_local()}</Select.Item>
                                            <Select.Item value="http">{msg.settings_dprice_http()}</Select.Item>
                                        </Select.Content>
                                    </Select.Root>
                                    <p class="text-xs text-muted-foreground">
                                        {#if settings.settings.dpriceMode === "integrated"}
                                            {msg.settings_dprice_integrated_desc()}
                                        {:else if settings.settings.dpriceMode === "local"}
                                            {msg.settings_dprice_local_desc()}
                                        {:else if settings.settings.dpriceMode === "http"}
                                            {msg.settings_dprice_http_desc()}
                                        {/if}
                                    </p>
                                </div>
                            {:else}
                                <p class="text-xs text-muted-foreground">
                                    {msg.settings_dprice_http_mode_hint()}
                                </p>
                            {/if}
                            {#if settings.settings.dpriceMode === "http"}
                                <div class="space-y-2">
                                    <label
                                        for="dprice-url"
                                        class="text-sm font-medium"
                                        >{msg.settings_dprice_server_url()}</label
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
                                <div class="space-y-2">
                                    <label
                                        for="dprice-api-key"
                                        class="text-sm font-medium"
                                        >{msg.settings_dprice_api_key()}</label
                                    >
                                    <Input
                                        id="dprice-api-key"
                                        type="password"
                                        value={settings.settings.dpriceApiKey ?? ""}
                                        oninput={(e) =>
                                            settings.update({
                                                dpriceApiKey:
                                                    (
                                                        e.target as HTMLInputElement
                                                    ).value || undefined,
                                            })}
                                        placeholder={msg.settings_dprice_api_key_placeholder()}
                                        class="w-80"
                                    />
                                </div>
                            {/if}
                            {#if settings.settings.dpriceMode === "local" && dpriceLocalPath}
                                <div class="rounded-md border bg-muted/50 p-3">
                                    <p class="text-xs text-muted-foreground">
                                        {msg.settings_dprice_db_path({ path: dpriceLocalPath ?? "" })}
                                    </p>
                                </div>
                            {/if}
                            <div class="space-y-2">
                                {#if dpriceLoading}
                                    <p class="text-sm text-muted-foreground">
                                        {msg.settings_dprice_loading()}
                                    </p>
                                {:else if dpriceHealth}
                                    <p class="text-sm">
                                        <span class="font-medium">{msg.label_status()}:</span>
                                        {msg.settings_dprice_status_info({ assets: dpriceHealth.assets.toLocaleString(), prices: dpriceHealth.prices.toLocaleString() })}
                                    </p>
                                    {#if dpriceLatest}
                                        {@const days = dpriceStaleDays()}
                                        {#if days !== null && days > 2}
                                            <p
                                                class="text-sm text-amber-600 dark:text-amber-400"
                                            >
                                                {msg.settings_dprice_stale({ date: dpriceLatest ?? "", days: String(days) })}
                                            </p>
                                        {:else}
                                            <p
                                                class="text-sm text-muted-foreground"
                                            >
                                                {days !== null
                                                    ? msg.settings_dprice_last_updated_ago({ date: dpriceLatest ?? "", ago: days === 0 ? msg.settings_dprice_today() : days === 1 ? msg.settings_dprice_one_day_ago() : msg.settings_dprice_days_ago({ days: String(days) }) })
                                                    : msg.settings_dprice_last_updated({ date: dpriceLatest ?? "" })}
                                            </p>
                                        {/if}
                                    {:else}
                                        <p
                                            class="text-sm text-muted-foreground"
                                        >
                                            {msg.settings_dprice_no_data()}
                                        </p>
                                    {/if}
                                {:else}
                                    <p class="text-sm text-muted-foreground">
                                        {msg.settings_dprice_unavailable()}
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
                                    {testResults.dprice?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                                {#if testResults.dprice?.status === 'success'}
                                    <span class="text-xs text-positive">{testResults.dprice.message ?? 'OK'}</span>
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
                                            ? msg.state_syncing()
                                            : msg.btn_sync_latest()}
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
                                            ? msg.state_syncing()
                                            : msg.btn_full_sync()}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={dpriceExporting}
                                        onclick={handleDpriceExport}
                                    >
                                        {dpriceExporting
                                            ? msg.state_exporting()
                                            : msg.btn_export_db()}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={dpriceImporting}
                                        onclick={handleDpriceImport}
                                    >
                                        {dpriceImporting
                                            ? msg.state_importing()
                                            : msg.btn_import_db()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.frankfurterEnabled === false}
                         class:pointer-events-none={settings.settings.frankfurterEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                {msg.settings_fiat_no_key()}
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.frankfurter?.status === 'testing'}
                                onclick={() => handleTest('frankfurter', testFrankfurter)}>
                                {testResults.frankfurter?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                            </Button>
                            {#if testResults.frankfurter?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.frankfurter.message ?? 'OK'}</span>
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.finnhub?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.finnhub?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.finnhub.message ?? 'OK'}</span>
                            {:else if testResults.finnhub?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.finnhub.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_finnhub_hint()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.coingecko?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            <div class="flex items-center gap-2">
                                <Switch
                                    id="coingecko-pro"
                                    checked={settings.settings.coingeckoPro ?? false}
                                    onCheckedChange={(checked) => settings.update({ coingeckoPro: checked })}
                                />
                                <label for="coingecko-pro" class="text-sm">{msg.label_pro_api()}</label>
                            </div>
                            {#if testResults.coingecko?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.coingecko.message ?? 'OK'}</span>
                            {:else if testResults.coingecko?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.coingecko.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {#if settings.settings.coingeckoPro}
                                    {@html msg.settings_coingecko_pro_hint()}
                                {:else}
                                    {@html msg.settings_coingecko_demo_hint()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.cryptocompare?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.cryptocompare?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.cryptocompare.message ?? 'OK'}</span>
                            {:else if testResults.cryptocompare?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.cryptocompare.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_cryptocompare_hint()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.defillamaEnabled === false}
                         class:pointer-events-none={settings.settings.defillamaEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                {msg.settings_defillama_no_key()}
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.defillama?.status === 'testing'}
                                onclick={() => handleTest('defillama', testDefiLlama)}>
                                {testResults.defillama?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                            </Button>
                            {#if testResults.defillama?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.defillama.message ?? 'OK'}</span>
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.binanceRatesEnabled === false}
                         class:pointer-events-none={settings.settings.binanceRatesEnabled === false}>
                        <div class="flex items-center gap-2">
                            <p class="text-sm text-muted-foreground">
                                {msg.settings_binance_no_key()}
                            </p>
                            <Button variant="outline" size="sm"
                                disabled={testResults.binance?.status === 'testing'}
                                onclick={() => handleTest('binance', testBinance)}>
                                {testResults.binance?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                            </Button>
                            {#if testResults.binance?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.binance.message ?? 'OK'}</span>
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.etherscan?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.etherscan?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.etherscan.message ?? 'OK'}</span>
                            {:else if testResults.etherscan?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.etherscan.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_etherscan_hint()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.routescan?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.routescan?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.routescan.message ?? 'OK'}</span>
                            {:else if testResults.routescan?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.routescan.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_routescan_hint()}
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
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
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
                                    {testResults.thegraph?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.thegraph?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.thegraph.message ?? 'OK'}</span>
                            {:else if testResults.thegraph?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.thegraph.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_thegraph_hint()}
                            </p>
                        </div>
                    </div>

                    <Separator />

                    <!-- Helius (Solana) -->
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Helius (Solana)</span>
                        <div class="flex items-center gap-2">
                            <Switch checked={settings.settings.heliusEnabled !== false}
                                onCheckedChange={(c) => settings.update({ heliusEnabled: c })} />
                            <label class="text-sm text-muted-foreground">{msg.label_enabled()}</label>
                        </div>
                    </div>
                    <div class:opacity-50={settings.settings.heliusEnabled === false}
                         class:pointer-events-none={settings.settings.heliusEnabled === false}>
                        <div class="space-y-2">
                            <label for="helius-api-key"
                                class="text-sm font-medium">Helius API Key</label
                            >
                            <div class="flex items-center gap-2">
                                <Input
                                    id="helius-api-key"
                                    type="password"
                                    placeholder="Helius API key"
                                    value={settings.settings.heliusApiKey ?? ""}
                                    oninput={(e: Event) => settings.update({ heliusApiKey: (e.target as HTMLInputElement).value })}
                                />
                                <Button variant="outline" size="sm"
                                    disabled={testResults.helius?.status === 'testing'}
                                    onclick={() => handleTest('helius', () => testHelius(settings.settings.heliusApiKey ?? ''))}>
                                    {testResults.helius?.status === 'testing' ? msg.state_testing() : msg.btn_test()}
                                </Button>
                            </div>
                            {#if testResults.helius?.status === 'success'}
                                <span class="text-xs text-positive">{testResults.helius.message ?? 'OK'}</span>
                            {:else if testResults.helius?.status === 'error'}
                                <span class="text-xs text-destructive">{testResults.helius.message}</span>
                            {/if}
                            <p class="text-xs text-muted-foreground">
                                {@html msg.settings_helius_hint()}
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
                    <Card.Title>{msg.settings_account_paths()}</Card.Title>
                    <Card.Description
                        >{msg.settings_account_paths_desc()}</Card.Description
                    >
                </div>
                <div class="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={countAffectedAccounts}
                        disabled={pathRenaming}
                    >
                        {msg.settings_check_existing()}
                    </Button>
                    {#if renameCounts.size > 0}
                        <Button
                            variant="default"
                            size="sm"
                            onclick={handleRenameAll}
                            disabled={pathRenaming}
                        >
                            {pathRenaming
                                ? msg.state_renaming()
                                : msg.settings_rename_accounts({ count: [...renameCounts.values()].reduce((a, b) => a + b, 0) })}
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
                            {msg.btn_reset()}
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
            <Card.Title>{msg.settings_default_accounts()}</Card.Title>
            <Card.Description
                >{msg.settings_default_accounts_desc()}</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <Select.Root type="single" bind:value={defaultSet}>
                        <Select.Trigger>
                            {defaultSet === "minimal" ? msg.account_set_minimal() : defaultSet === "standard" ? msg.account_set_standard() : msg.account_set_comprehensive()}
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="minimal">{msg.account_set_minimal()}</Select.Item>
                            <Select.Item value="standard">{msg.account_set_standard()}</Select.Item>
                            <Select.Item value="comprehensive">{msg.account_set_comprehensive()}</Select.Item>
                        </Select.Content>
                    </Select.Root>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onclick={handleCreateDefaults}
                    disabled={creatingDefaults}
                >
                    {creatingDefaults ? msg.state_creating() : msg.settings_create_accounts()}
                </Button>
            </div>
        </Card.Content>
    </Card.Root>

    <!-- Custom Plugins -->
    <Card.Root>
        <Card.Header>
            <div class="flex items-center justify-between">
                <div>
                    <Card.Title class="flex items-center gap-2">
                        <Puzzle class="h-5 w-5" />
                        {msg.settings_plugins_title()}
                    </Card.Title>
                    <Card.Description>{msg.settings_plugins_desc()}</Card.Description>
                </div>
                <Button size="sm" onclick={() => { addPluginDialogOpen = true; addPluginCode = ""; addPluginError = ""; }}>
                    <Plus class="mr-1 h-4 w-4" />
                    {msg.settings_plugins_add()}
                </Button>
            </div>
        </Card.Header>
        <Card.Content class="space-y-4">
            {#if customPlugins.length === 0}
                <p class="text-sm text-muted-foreground">{msg.settings_plugins_none()}</p>
            {:else}
                {#each customPlugins as plugin (plugin.id)}
                    <div class="flex items-center justify-between rounded-md border p-3">
                        <div class="space-y-0.5">
                            <p class="text-sm font-medium">{plugin.name}</p>
                            <p class="text-xs text-muted-foreground">
                                v{plugin.version}
                                {#if plugin.description}
                                    &mdash; {plugin.description}
                                {/if}
                            </p>
                            <p class="text-xs text-muted-foreground">
                                {msg.settings_plugins_loaded_at({ date: new Date(plugin.created_at).toLocaleDateString() })}
                            </p>
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="flex items-center gap-2">
                                <span class="text-xs text-muted-foreground">
                                    {plugin.enabled ? msg.settings_plugins_enabled() : msg.settings_plugins_disabled()}
                                </span>
                                <Switch
                                    checked={plugin.enabled}
                                    onCheckedChange={() => togglePluginEnabled(plugin)}
                                />
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                class="h-8 w-8"
                                onclick={() => showPluginCode(plugin)}
                                title={msg.settings_plugins_view_code()}
                            >
                                <Code class="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                class="h-8 w-8 text-destructive hover:text-destructive"
                                onclick={() => deletePlugin(plugin)}
                            >
                                <Trash2 class="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                {/each}
            {/if}
        </Card.Content>
    </Card.Root>

    <!-- Add Plugin Dialog -->
    <Dialog.Root bind:open={addPluginDialogOpen}>
        <Dialog.Content class="sm:max-w-lg">
            <Dialog.Header>
                <Dialog.Title>{msg.settings_plugins_add()}</Dialog.Title>
                <Dialog.Description>{msg.feedback_load_desc()}</Dialog.Description>
            </Dialog.Header>
            <div class="space-y-4">
                <textarea
                  class="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  placeholder="// Paste your plugin code here..."
                  bind:value={addPluginCode}
                ></textarea>
                {#if addPluginError}
                    <p class="text-xs text-destructive">{addPluginError}</p>
                {/if}
            </div>
            <Dialog.Footer class="flex-col sm:flex-row gap-2">
                <div class="flex-1">
                    <Button variant="outline" size="sm" onclick={() => pluginFileInput?.click()}>
                        <Upload class="mr-1 h-4 w-4" />
                        {msg.btn_load_from_file()}
                    </Button>
                    <input
                      bind:this={pluginFileInput}
                      type="file"
                      accept=".js,.ts,.mjs,.txt"
                      class="hidden"
                      onchange={handlePluginFileLoad}
                    />
                </div>
                <div class="flex gap-2">
                    <Button variant="outline" onclick={() => { addPluginDialogOpen = false; }}>
                        {msg.btn_cancel()}
                    </Button>
                    <Button disabled={!addPluginCode.trim()} onclick={handleAddPlugin}>
                        {msg.feedback_load_validate()}
                    </Button>
                </div>
            </Dialog.Footer>
        </Dialog.Content>
    </Dialog.Root>

    <!-- View Plugin Code Dialog -->
    <Dialog.Root bind:open={viewCodeDialogOpen}>
        <Dialog.Content class="sm:max-w-2xl">
            <Dialog.Header>
                <Dialog.Title>{viewCodePlugin?.name ?? ""}</Dialog.Title>
                <Dialog.Description>
                    v{viewCodePlugin?.version ?? ""}
                    {#if viewCodePlugin?.description}
                        &mdash; {viewCodePlugin.description}
                    {/if}
                </Dialog.Description>
            </Dialog.Header>
            <div class="relative">
                {#if viewCodeHtml}
                    <div class="max-h-[60vh] overflow-auto rounded-md border text-xs [&_pre]:!p-4 [&_pre]:!m-0 [&_pre]:!rounded-md [&_code]:!text-xs">
                        {@html viewCodeHtml}
                    </div>
                {:else}
                    <pre class="max-h-[60vh] overflow-auto rounded-md border bg-muted p-4 text-xs font-mono whitespace-pre-wrap">{viewCodePlugin?.source_code ?? ""}</pre>
                {/if}
                <button
                    type="button"
                    class="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                    onclick={copyPluginCode}
                >
                    {#if viewCodeCopied}
                        <Check class="h-4 w-4 text-green-500" />
                    {:else}
                        <Copy class="h-4 w-4" />
                    {/if}
                </button>
            </div>
            <Dialog.Footer>
                <Button variant="outline" onclick={() => { viewCodeDialogOpen = false; }}>
                    {msg.btn_close()}
                </Button>
            </Dialog.Footer>
        </Dialog.Content>
    </Dialog.Root>

    <!-- Data Management -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{msg.settings_data_management()}</Card.Title>
            <Card.Description
                >{msg.settings_data_management_desc()}</Card.Description
            >
        </Card.Header>
        <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_portable_export()}</p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_portable_export_desc()}
                    </p>
                </div>
                <div class="flex gap-2">
                    <Button variant="outline" size="sm" onclick={() => exportDialogOpen = true}>
                        <Download class="mr-1 h-4 w-4" />
                        {msg.btn_export_dledger()}
                    </Button>
                    <Button variant="outline" size="sm" onclick={() => importDialogOpen = true}>
                        <Upload class="mr-1 h-4 w-4" />
                        {msg.btn_import_dledger()}
                    </Button>
                </div>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_export_database()}</p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_export_database_desc()}
                    </p>
                </div>
                <div class="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={exporting}
                        onclick={async () => {
                            exporting = true;
                            try {
                                const data = await exportDatabaseBackup(getBackend());
                                downloadDatabase(data);
                                toast.success(msg.toast_database_exported());
                            } catch (e) {
                                toast.error(e instanceof Error ? e.message : String(e));
                            } finally {
                                exporting = false;
                            }
                        }}
                    >
                        {exporting ? msg.state_exporting() : msg.btn_export_dot_db()}
                    </Button>
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
                                if (!window.confirm(msg.confirm_import_db({ name: file.name }))) return;
                                importing = true;
                                try {
                                    const data = await readFileAsUint8Array(file);
                                    const backend = getBackend();
                                    if (!backend.importDatabase) {
                                        throw new Error(msg.error_import_not_supported());
                                    }
                                    await backend.importDatabase(data);
                                    toast.success(msg.toast_database_imported_reloading());
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
                        {importing ? msg.state_importing() : msg.btn_import_dot_db()}
                    </Button>
                </div>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_clear_exchange_rates()}</p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_clear_exchange_rates_desc()}
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearExchangeRates}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-exchange-rates")
                        ? msg.state_clearing()
                        : msg.settings_clear_rates_btn()}
                </Button>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_clear_ledger_data()}</p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_clear_ledger_data_desc()}
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearLedgerData}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-ledger-data")
                        ? msg.state_clearing()
                        : msg.settings_clear_ledger_btn()}
                </Button>
            </div>
            <Separator />
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{msg.settings_clear_all_data()}</p>
                    <p class="text-sm text-muted-foreground">
                        {msg.settings_clear_all_data_desc()}
                    </p>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onclick={handleClearAllData}
                    disabled={clearing}
                >
                    {taskQueue.isActive("clear-all-data")
                        ? msg.state_clearing()
                        : msg.settings_clear_all_data()}
                </Button>
            </div>
        </Card.Content>
    </Card.Root>

    {#if import.meta.env.DEV}
        <Card.Root>
            <Card.Header>
                <Card.Title>{msg.settings_development()}</Card.Title>
                <Card.Description
                    >{msg.settings_development_desc()}</Card.Description
                >
            </Card.Header>
            <Card.Content>
                <label class="flex items-center gap-2 text-sm">
                    <Switch
                        checked={settings.debugMode}
                        onCheckedChange={(v) =>
                            settings.update({ debugMode: v })}
                    />
                    {msg.settings_debug_mode()}
                </label>
            </Card.Content>
        </Card.Root>
    {/if}
</div>

<ExportDialog bind:open={exportDialogOpen} />
<DledgerImportDialog bind:open={importDialogOpen} />

{#if confirmCurrencyOpen}
    <AlertDialog.Root open={confirmCurrencyOpen} onOpenChange={(v) => { if (!v && confirmCurrencyOpen) cancelCurrencyChange(); }}>
        <AlertDialog.Portal>
            <AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/50" />
            <AlertDialog.Content class="fixed top-1/2 left-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 bg-background rounded-lg border p-6 shadow-lg max-w-sm w-full">
                <AlertDialog.Title class="text-lg font-semibold">{msg.dialog_change_currency()}</AlertDialog.Title>
                <AlertDialog.Description class="text-sm text-muted-foreground mt-2">
                    {msg.dialog_change_currency_desc({ currency: pendingCurrency })}
                </AlertDialog.Description>
                <div class="flex justify-end gap-2 mt-4">
                    <AlertDialog.Cancel
                        class="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                        onclick={cancelCurrencyChange}
                    >
                        {msg.btn_cancel()}
                    </AlertDialog.Cancel>
                    <AlertDialog.Action
                        class="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                        onclick={applyBaseCurrencyChange}
                    >
                        {msg.btn_confirm()}
                    </AlertDialog.Action>
                </div>
            </AlertDialog.Content>
        </AlertDialog.Portal>
    </AlertDialog.Root>
{/if}
