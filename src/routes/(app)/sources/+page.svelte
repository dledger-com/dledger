<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Card from "$lib/components/ui/card/index.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import { Switch } from "$lib/components/ui/switch/index.js";
    import { getBackend } from "$lib/backend.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { invalidate } from "$lib/data/invalidation.js";
    import {
        getHiddenCurrencySet,
    } from "$lib/data/hidden-currencies.svelte.js";
    import { toast } from "svelte-sonner";
    import { feedbackWizard } from "$lib/data/feedback.svelte.js";
    import MessageCircleQuestion from "lucide-svelte/icons/message-circle-question";
    import * as Command from "$lib/components/ui/command/index.js";
    import * as Popover from "$lib/components/ui/popover/index.js";
    import { cn } from "$lib/utils.js";
    import Upload from "lucide-svelte/icons/upload";
    import Trash2 from "lucide-svelte/icons/trash-2";
    import RefreshCw from "lucide-svelte/icons/refresh-cw";
    import Plus from "lucide-svelte/icons/plus";
    import Check from "lucide-svelte/icons/check";
    import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
    import X from "lucide-svelte/icons/x";
    import Pencil from "lucide-svelte/icons/pencil";
    import Copy from "lucide-svelte/icons/copy";
    import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
    import * as Collapsible from "$lib/components/ui/collapsible/index.js";
    import {
        enqueueRateBackfill,
    } from "$lib/exchange-rate-historical.js";
    import { importDrop } from "$lib/data/import-drop.svelte.js";
    import type { ChainInfo, EtherscanAccount } from "$lib/types/index.js";
    import { SUPPORTED_CHAINS } from "$lib/types/index.js";
    import {
        getDefaultRegistry,
        dryRunReprocess,
        type ReprocessResult,
    } from "$lib/handlers/index.js";
    import { isTheGraphSupportedChain } from "$lib/thegraph-token-api.js";
    import { reprocessStore } from "$lib/data/reprocess-store.svelte.js";
    import RotateCw from "lucide-svelte/icons/rotate-cw";
    import { v7 as uuidv7 } from "uuid";
    import { detectInputType, type QuickDetection } from "$lib/bitcoin/validate.js";
    import { detectEvmInputType, deriveEvmAddress, validateEvmSeedPhrase, deriveEvmAddressesFromSeed, deriveEvmAddressesFromXpub } from "$lib/evm/derive.js";
    import { detectBtcInputType, convertPrivateKey, deriveMultiXpubsFromSeed } from "$lib/bitcoin/derive.js";
    import type { DerivedBtcXpub } from "$lib/bitcoin/derive.js";
    import { BLOCKCHAIN_CHAINS, getBlockchainConfig, type BlockchainConfig } from "$lib/blockchain-registry.js";
    import BlockchainAddForm from "$lib/components/BlockchainAddForm.svelte";
    import AddOnlineSourceDialog from "$lib/components/AddOnlineSourceDialog.svelte";
    import BlockchainAccountRow from "$lib/components/BlockchainAccountRow.svelte";
    import type { ExchangeAccount } from "$lib/cex/types.js";
    import {
        getCexAdapter,
        getAllCexAdapters,
        syncCexAccount,
        retroactiveConsolidate,
    } from "$lib/cex/index.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import Link2 from "lucide-svelte/icons/link-2";
    import SortableHeader from "$lib/components/SortableHeader.svelte";
    import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
    import AddSourceInput from "$lib/components/AddSourceInput.svelte";
    import ExchangeIcon from "$lib/components/ExchangeIcon.svelte";
    import ChainIcon from "$lib/components/ChainIcon.svelte";
    import { getDefaultPresetRegistry } from "$lib/csv-presets/index.js";
    import { getPluginManager } from "$lib/plugins/manager.js";
    import CategorizationRulesEditor from "$lib/components/CategorizationRulesEditor.svelte";
    import type { ExchangeId } from "$lib/cex/types.js";
    import {
        setBankStatementRules,
        setRevolutRules,
        setLaBanquePostaleRules,
        setN26Rules,
        type CsvCategorizationRule,
    } from "$lib/csv-presets/index.js";

    let fileInputEl = $state<HTMLInputElement | null>(null);

    function handleImportClick() {
        fileInputEl?.click();
    }

    async function handleFileInputChange(e: Event) {
        const input = e.target as HTMLInputElement;
        const files = input.files;
        if (files && files.length > 0) {
            await importDrop.routeFiles(Array.from(files));
        }
        input.value = "";
    }

    const handlerRegistry = getDefaultRegistry();
    const handlers = handlerRegistry.getAll();

    function shortPresetName(name: string): string {
        return name.replace(/ (Ledger Export|Trade History|Transactions|Bank Statement|Statement|App|Exchange)$/i, "").trim();
    }
    const csvPresetNames = [...new Set(
        getDefaultPresetRegistry().getAll()
            .filter(p => p.id !== "bank-statement")
            .map(p => shortPresetName(p.name))
    )].sort((a, b) => a.localeCompare(b));
    const pdfParserNames = [...new Set(
        getPluginManager().pdfParsers.getAll()
            .map(p => shortPresetName(p.name))
    )].sort((a, b) => a.localeCompare(b));

    const PROTOCOL_CONTRACTS: Record<string, { label: string; address: string }[]> = {
        uniswap: [
            { label: "Universal Router", address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad" },
            { label: "V3 Position Manager", address: "0xc36442b4a4522e871399cd717abdd847ab11fe88" },
        ],
        aave: [
            { label: "V3 Pool (ETH)", address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2" },
        ],
        lido: [
            { label: "stETH Token", address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84" },
            { label: "wstETH Token", address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0" },
        ],
        compound: [
            { label: "Comet (USDC)", address: "0xc3d688b66703497daa19211eedff47f25384cdc3" },
        ],
        curve: [
            { label: "Router", address: "0xf0d4c12a5768d806021f80a262b4d39d26c58b8d" },
        ],
        eigenlayer: [
            { label: "Strategy Manager", address: "0x858646372cc42e1a627fce94aa7a7033e7cf075a" },
        ],
    };

    const protocolInfos = handlers
        .filter((h) => h.supportedChainIds.length > 0)
        .map((h) => ({
            ...h,
            chains: h.supportedChainIds
                .map((cid) => SUPPORTED_CHAINS.find((c) => c.chain_id === cid)?.name ?? `Chain ${cid}`)
                .sort(),
            contracts: PROTOCOL_CONTRACTS[h.id] ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    let protocolFilter = $state("");

    const filteredProtocolInfos = $derived(() => {
        if (!protocolFilter.trim()) return protocolInfos;
        const q = protocolFilter.trim().toLowerCase();
        return protocolInfos.filter(
            (p) => p.name.toLowerCase().includes(q) || p.chains.some((c) => c.toLowerCase().includes(q))
        );
    });

    const settings = new SettingsStore();

    // -- Categorization rules --
    let categorizationRules = $state<CsvCategorizationRule[]>([]);
    $effect(() => {
        categorizationRules = settings.settings.csvCategorizationRules ?? [];
    });

    // -- Etherscan state --
    let ethAccounts = $state<EtherscanAccount[]>([]);
    const ethBusy = $derived(taskQueue.isActive("etherscan-sync"));

    // -- Inline label edit state (BTC/SOL/HL/CEX) --
    let editingRowId = $state<string | null>(null);
    let editingRowLabel = $state("");

    function startEditLabel(id: string, currentLabel: string) {
        editingRowId = id;
        editingRowLabel = currentLabel;
    }

    async function saveEditLabel(kind: string) {
        if (!editingRowId) return;
        const label = editingRowLabel.trim();
        if (!label) { editingRowId = null; return; }
        try {
            if (kind === "btc") {
                await getBackend().updateBitcoinAccountLabel(editingRowId, label);
                await loadBtcAccounts();
            } else if (kind === "cex") {
                await getBackend().updateExchangeAccount(editingRowId, { label });
                await loadCexAccounts();
            } else {
                // Generic blockchain chain
                const config = getBlockchainConfig(kind);
                if (config) {
                    await (getBackend() as any)[config.backendUpdateLabel](editingRowId, label);
                    await loadChainAccounts(config);
                }
            }
        } catch (err) {
            toast.error(`Failed to update label: ${err}`);
        }
        editingRowId = null;
    }

    // -- Inline edit state (EVM-specific, has chain selection) --
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
                map.set(acc.address, {
                    address: acc.address,
                    label: acc.label,
                    chainIds: [acc.chain_id],
                });
            }
        }
        for (const g of map.values()) g.chainIds.sort((a, b) => a - b);
        return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
    });

    // Merged blockchain rows (BTC + EVM + generic chains)
    type BlockchainRow =
        | { kind: "btc"; data: import("$lib/bitcoin/types.js").BitcoinAccount }
        | { kind: "evm"; data: GroupedAddress }
        | { kind: string; data: any };

    const blockchainRows = $derived.by((): BlockchainRow[] => {
        const rows: BlockchainRow[] = [];
        for (const account of btcAccounts) rows.push({ kind: "btc", data: account });
        for (const group of groupedAddresses) rows.push({ kind: "evm", data: group });
        for (const config of BLOCKCHAIN_CHAINS) {
            const state = chainStates.get(config.id);
            if (state) {
                for (const account of state.accounts) {
                    rows.push({ kind: config.id, data: account });
                }
            }
        }
        return rows;
    });

    // -- Handler change suggestion state --
    let reprocessSuggested = $state(false);

    function suggestReprocess() {
        if (reprocessSuggested) return;
        reprocessSuggested = true;
        toast.info(
            "Handler config changed — reprocess existing transactions to apply new handlers.",
            {
                action: {
                    label: "Reprocess All",
                    onClick: () => handleReprocessAll(),
                },
            },
        );
    }

    // -- Reprocess state --
    const reprocessing = $derived(taskQueue.isActive("reprocess-dryrun"));
    const applyingReprocess = $derived(taskQueue.isActive("reprocess-apply"));

    const backfilling = $derived(taskQueue.isActive("rate-backfill"));

    // -- CEX state --
    let cexAccounts = $state<ExchangeAccount[]>([]);

    // Sort state for CEX accounts table
    type CexSortKey = "exchange" | "label" | "lastSync";
    const sortCex = createSortState<CexSortKey>();
    const cexAccessors: Record<CexSortKey, SortAccessor<ExchangeAccount>> = {
        exchange: (a) => a.exchange,
        label: (a) => a.label,
        lastSync: (a) => a.last_sync || "",
    };

    // Sort state for Blockchain Accounts table
    type BlockchainSortKey = "address" | "label" | "type" | "networks" | "lastSync";
    const sortBlockchain = createSortState<BlockchainSortKey>();
    function getBlockchainRowAddress(r: BlockchainRow): string {
        if (r.kind === "btc") return r.data.address_or_xpub;
        if (r.kind === "evm") return r.data.address;
        return r.data.address;
    }
    const CHAIN_TYPE_LABELS: Record<string, string> = {
        btc: "BTC",
        evm: "EVM",
        ...Object.fromEntries(BLOCKCHAIN_CHAINS.map(c => [c.id, c.name])),
    };
    const blockchainAccessors: Record<BlockchainSortKey, SortAccessor<BlockchainRow>> = {
        address: (r) => getBlockchainRowAddress(r),
        label: (r) => r.data.label,
        type: (r) => r.kind === "btc"
            ? (r.data.account_type === "address" ? "BTC Address" : "HD Wallet")
            : CHAIN_TYPE_LABELS[r.kind] ?? "EVM",
        networks: (r) => r.kind === "btc"
            ? "Bitcoin"
            : r.kind === "evm" ? r.data.chainIds.map((id: number) => getChainName(id)).join(", ")
            : CHAIN_TYPE_LABELS[r.kind] ?? r.kind,
        lastSync: (r) => r.kind === "evm" ? "" : (r.data.last_sync || ""),
    };

    function isAccountClosed(account: ExchangeAccount): boolean {
        if (!account.closed_at) return false;
        return account.closed_at < new Date().toISOString().slice(0, 10);
    }

    let addDialogOpen = $state(false);
    const cexBusy = $derived(taskQueue.isActive("cex-sync"));
    const cexConsolidating = $derived(taskQueue.isActive("cex-consolidate"));

    const EXCHANGE_NAMES = Object.fromEntries(
        getAllCexAdapters().map((a) => [a.exchangeId, a.exchangeName]),
    ) as Record<ExchangeId, string>;

    async function handleAccountAdded() {
        await loadCexAccounts();
        await loadEthAccounts();
        await loadBtcAccounts();
        await loadAllChainAccounts();
    }

    // -- Bitcoin state --
    let btcAccounts = $state<import("$lib/bitcoin/types.js").BitcoinAccount[]>([]);

    // -- Generic blockchain chain state (replaces per-chain state variables) --
    type ChainState = { accounts: any[]; busy: boolean };
    let chainStates = $state<Map<string, ChainState>>(new Map(
        BLOCKCHAIN_CHAINS.map(c => [c.id, { accounts: [], busy: false }])
    ));

    function isChainBusy(chainId: string): boolean {
        const config = getBlockchainConfig(chainId);
        return config ? taskQueue.isActive(config.syncTaskPrefix) : false;
    }

    const btcBusy = $derived(taskQueue.isActive("btc-sync"));

    async function loadBtcAccounts() {
        try {
            btcAccounts = await getBackend().listBitcoinAccounts();
        } catch {
            // Silently ignore — table may not exist yet if DB schema is older
        }
    }


    async function handleRemoveBtcAccount(id: string) {
        try {
            await getBackend().removeBitcoinAccount(id);
            await loadBtcAccounts();
            toast.success("Bitcoin account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncBtcAccount(account: import("$lib/bitcoin/types.js").BitcoinAccount) {
        taskQueue.enqueue({
            key: `btc-sync:${account.id}`,
            label: `Sync ${account.label} (Bitcoin)`,
            async run(ctx) {
                const r = await getBackend().syncBitcoin(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadBtcAccounts();
                if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
                if (r.transactions_imported > 0) {
                    enqueueRateBackfill(
                        taskQueue,
                        getBackend(),
                        settings.buildRateConfig(),
                        getHiddenCurrencySet(),
                    );
                }
                return {
                    summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`,
                    data: r,
                };
            },
        });
    }

    function syncAllBtc() {
        for (const account of btcAccounts) {
            syncBtcAccount(account);
        }
    }

    // ---- Generic blockchain chain functions ----

    async function loadChainAccounts(config: BlockchainConfig) {
        try {
            const backend = getBackend();
            const accounts = await (backend as any)[config.backendList]();
            const state = chainStates.get(config.id);
            if (state) { chainStates.set(config.id, { ...state, accounts }); chainStates = new Map(chainStates); }
        } catch {
            // Silently ignore — table may not exist yet if DB schema is older
        }
    }

    async function loadAllChainAccounts() {
        for (const config of BLOCKCHAIN_CHAINS) {
            await loadChainAccounts(config);
        }
    }

    function syncChainAccount(config: BlockchainConfig, account: any) {
        taskQueue.enqueue({
            key: `${config.syncTaskPrefix}:${account.id}`,
            label: `Sync ${account.label} (${config.name})`,
            async run(ctx) {
                const r = await (getBackend() as any)[config.backendSync](
                    account,
                    (msg: string) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadChainAccounts(config);
                const imported = r.transactions_imported ?? r.fills_imported ?? 0;
                const skipped = r.transactions_skipped ?? 0;
                if (imported > 0) invalidate("journal", "accounts", "reports");
                if (imported > 0) {
                    enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet());
                }
                return { summary: `${imported} imported${skipped ? `, ${skipped} skipped` : ""}`, data: r };
            },
        });
    }

    async function removeChainAccount(config: BlockchainConfig, id: string) {
        try {
            await (getBackend() as any)[config.backendRemove](id);
            await loadChainAccounts(config);
            toast.success(`${config.name} account removed`);
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    const anyBusy = $derived(
        cexBusy || ethBusy || btcBusy ||
        BLOCKCHAIN_CHAINS.some(c => taskQueue.isActive(c.syncTaskPrefix))
    );


    async function loadCexAccounts() {
        try {
            cexAccounts = await getBackend().listExchangeAccounts();
        } catch (err) {
            toast.error(`Failed to load exchange accounts: ${err}`);
        }
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).then(() => {
            toast.success("Copied to clipboard");
        });
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
        if (isAccountClosed(account)) return;
        const adapter = getCexAdapter(account.exchange);
        taskQueue.enqueue({
            key: `cex-sync:${account.id}`,
            label: `Sync ${account.label} (${adapter.exchangeName})`,
            async run(ctx) {
                const result = await syncCexAccount(
                    getBackend(),
                    adapter,
                    account,
                    handlerRegistry,
                    {
                        signal: ctx.signal,
                        onProgress: ctx.reportProgress,
                    },
                );
                await loadCexAccounts();
                if (result.entries_imported > 0) invalidate("journal", "accounts", "reports");
                // Auto-trigger consolidation if entries were imported and etherscan accounts exist
                if (result.entries_imported > 0 && ethAccounts.length > 0) {
                    handleConsolidateCex();
                }
                // Auto-backfill missing exchange rates
                if (result.entries_imported > 0) {
                    enqueueRateBackfill(
                        taskQueue,
                        getBackend(),
                        settings.buildRateConfig(),
                        getHiddenCurrencySet(),
                    );
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
                const result = await retroactiveConsolidate(
                    getBackend(),
                    handlerRegistry,
                    {
                        signal: ctx.signal,
                        onProgress: ctx.reportProgress,
                    },
                );
                if (result.pairs_found === 0) {
                    return { summary: "No matching pairs found" };
                }
                return {
                    summary: `${result.pairs_consolidated} consolidated, ${result.pairs_skipped} skipped of ${result.pairs_found} pairs`,
                };
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
        loadBtcAccounts();
        loadAllChainAccounts();
    });


    async function handleRemoveEthAccount(account: EtherscanAccount) {
        try {
            await getBackend().removeEtherscanAccount(
                account.address,
                account.chain_id,
            );
            await loadEthAccounts();
            toast.success("Address removed");
        } catch (err) {
            toast.error(String(err));
        }
    }

    function pickSyncSource(chainId: number): { type: "etherscan"; apiKey: string } | { type: "thegraph"; apiKey: string } | null {
        const ethKey = settings.etherscanApiKey;
        if (ethKey && settings.settings.etherscanEnabled !== false) {
            return { type: "etherscan", apiKey: ethKey };
        }
        const graphKey = settings.theGraphApiKey;
        if (graphKey && settings.settings.theGraphEnabled !== false && isTheGraphSupportedChain(chainId)) {
            return { type: "thegraph", apiKey: graphKey };
        }
        return null;
    }

    function syncEthAccount(account: EtherscanAccount) {
        const source = pickSyncSource(account.chain_id);
        if (!source) {
            toast.error("No API key configured. Set an Etherscan or The Graph API key in Settings.");
            return;
        }
        const viaLabel = source.type === "thegraph" ? " (via The Graph)" : "";
        taskQueue.enqueue({
            key: `etherscan-sync:${account.address}:${account.chain_id}`,
            label: `Sync ${account.label} (${getChainName(account.chain_id)})${viaLabel}`,
            async run() {
                const r = source.type === "thegraph"
                    ? await getBackend().syncTheGraph(
                        source.apiKey,
                        account.address,
                        account.label,
                        account.chain_id,
                    )
                    : await getBackend().syncEtherscan(
                        source.apiKey,
                        account.address,
                        account.label,
                        account.chain_id,
                    );
                await loadEthAccounts();
                if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
                // Auto-trigger consolidation if entries were imported and CEX accounts exist
                if (r.transactions_imported > 0 && cexAccounts.length > 0) {
                    handleConsolidateCex();
                }
                // Auto-backfill missing exchange rates
                if (r.transactions_imported > 0) {
                    enqueueRateBackfill(
                        taskQueue,
                        getBackend(),
                        settings.buildRateConfig(),
                        getHiddenCurrencySet(),
                    );
                }
                return {
                    summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`,
                    data: r,
                };
            },
        });
    }

    function handleSyncAll() {
        if (ethAccounts.length === 0) {
            toast.error("No tracked addresses to sync");
            return;
        }
        let hasAnyKey = false;
        for (const account of ethAccounts) {
            if (pickSyncSource(account.chain_id)) {
                hasAnyKey = true;
                syncEthAccount(account);
            }
        }
        if (!hasAnyKey) {
            toast.error("No API key configured. Set an Etherscan or The Graph API key in Settings.");
        }
    }

    function syncAll() {
        for (const account of cexAccounts) syncCex(account);
        if (ethAccounts.length > 0) {
            for (const account of ethAccounts) {
                if (pickSyncSource(account.chain_id)) syncEthAccount(account);
            }
        }
        if (btcAccounts.length > 0) syncAllBtc();
        // Sync all generic blockchain chains
        for (const config of BLOCKCHAIN_CHAINS) {
            const state = chainStates.get(config.id);
            if (state) {
                for (const account of state.accounts) {
                    syncChainAccount(config, account);
                }
            }
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
                    onProgress: (processed, total) =>
                        ctx.reportProgress({ current: processed, total }),
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
                    data: {
                        result: r,
                        target: {
                            chainId: account.chain_id,
                            address: account.address,
                            label: account.label,
                        },
                    },
                    actionRequired: true,
                    actionLabel: `Review ${r.changed} Change(s)`,
                };
            },
            onAction(task) {
                const d = task.result?.data as
                    | {
                          result: ReprocessResult;
                          target: {
                              chainId: number;
                              address: string;
                              label: string;
                          };
                      }
                    | undefined;
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
                    const r = await dryRunReprocess(
                        getBackend(),
                        handlerRegistry,
                        {
                            chainId: account.chain_id,
                            address: account.address,
                            label: account.label,
                            settings: settings.settings,
                            onProgress: (processed, total) => {
                                ctx.reportProgress({
                                    current: processedSoFar + processed,
                                    total: processedSoFar + total,
                                });
                            },
                        },
                    );
                    processedSoFar += r.total;
                    combined.total += r.total;
                    combined.unchanged += r.unchanged;
                    combined.changed += r.changed;
                    combined.skipped += r.skipped;
                    combined.errors.push(...r.errors);
                    combined.changes.push(...r.changes);
                    combined.currencyHints = {
                        ...combined.currencyHints,
                        ...r.currencyHints,
                    };
                }
                if (combined.total === 0) {
                    toast.info(
                        "No raw transaction data found — re-sync your accounts first",
                    );
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
                const d = task.result?.data as
                    | { result: ReprocessResult; target: null }
                    | undefined;
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
                    .map((a) => a.chain_id),
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
            syncEthAccount({
                address: group.address,
                chain_id: chainId,
                label: group.label,
            });
        }
    }

    function handleReprocessGroup(group: GroupedAddress) {
        for (const chainId of group.chainIds) {
            handleReprocessOne({
                address: group.address,
                chain_id: chainId,
                label: group.label,
            });
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
    <!-- Import Files -->
    <Card.Root>
        <Card.Header>
            <div class="flex items-center justify-between">
                <div>
                    <Card.Title>{m.sources_import_files()}</Card.Title>
                    <Card.Description>
                        {m.sources_import_files_desc()}
                        <span class="mt-2 flex flex-col gap-1.5">
                            <span class="flex flex-wrap items-center gap-1">
                                <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">CSV</span>
                                {#each csvPresetNames as name}
                                    <Badge variant="outline">{name}</Badge>
                                {/each}
                            </span>
                            <span class="flex flex-wrap items-center gap-1">
                                <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">OFX / QFX / QBO</span>
                            </span>
                            <span class="flex flex-wrap items-center gap-1">
                                <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">PDF</span>
                                {#each pdfParserNames as name}
                                    <Badge variant="outline">{name}</Badge>
                                {/each}
                            </span>
                            <span class="flex flex-wrap items-center gap-1">
                                <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">{m.sources_plain_text()}</span>
                                {#each ["Beancount", "hledger", "ledger"] as name}
                                    <Badge variant="outline">{name}</Badge>
                                {/each}
                            </span>
                        </span>
                        <button
                          type="button"
                          class="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
                          onclick={() => feedbackWizard.openMissingSource()}
                        >
                          <MessageCircleQuestion class="h-3 w-3" />
                          {m.feedback_missing_source_link()}
                        </button>
                    </Card.Description>
                </div>
                <Button size="sm" class="shrink-0" onclick={handleImportClick}>
                    <Upload class="mr-1 h-4 w-4" /> {m.btn_import()}
                </Button>
                <input
                    bind:this={fileInputEl}
                    type="file"
                    multiple
                    accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo,.pdf,.ledger,.beancount,.journal,.hledger,.dat,.zip"
                    class="hidden"
                    onchange={handleFileInputChange}
                />
            </div>
        </Card.Header>
    </Card.Root>

    <!-- Online Sources -->
    <Card.Root>
        <Card.Header>
            <div class="flex items-center justify-between">
                <div>
                    <Card.Title>{m.sources_online()}</Card.Title>
                    <Card.Description>{m.sources_online_desc()}</Card.Description>
                </div>
                <Button size="sm" onclick={() => addDialogOpen = true} disabled={anyBusy}>
                    <Plus class="mr-1 h-4 w-4" />
                    {m.btn_add()}
                </Button>
            </div>
        </Card.Header>
        <Card.Content class="space-y-6">

            <!-- Blockchain Accounts sub-section (merged BTC + EVM + SOL) -->
            {#if blockchainRows.length > 0}
                <div class="space-y-2">
                    <div class="flex items-center justify-between">
                        <h4 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sources_blockchain_accounts()}</h4>
                        <span class="text-xs text-muted-foreground">
                            {m.sources_api_keys()}: <a href="/settings" class="underline hover:text-foreground">{m.nav_settings()}</a>
                            {#if groupedAddresses.length > 0 && !settings.etherscanApiKey}
                                <span class="text-amber-600 dark:text-amber-400 ml-1">({m.sources_not_set()})</span>
                            {/if}
                        </span>
                    </div>
                    <Table.Root>
                        <Table.Header class="hidden sm:table-header-group">
                            <Table.Row>
                                <SortableHeader active={sortBlockchain.key === "address"} direction={sortBlockchain.direction} onclick={() => sortBlockchain.toggle("address")}>{m.sources_address_key()}</SortableHeader>
                                <SortableHeader active={sortBlockchain.key === "label"} direction={sortBlockchain.direction} onclick={() => sortBlockchain.toggle("label")}>{m.label_label()}</SortableHeader>
                                <SortableHeader active={sortBlockchain.key === "type"} direction={sortBlockchain.direction} onclick={() => sortBlockchain.toggle("type")}>{m.label_type()}</SortableHeader>
                                <SortableHeader active={sortBlockchain.key === "networks"} direction={sortBlockchain.direction} onclick={() => sortBlockchain.toggle("networks")}>{m.sources_networks()}</SortableHeader>
                                <SortableHeader active={sortBlockchain.key === "lastSync"} direction={sortBlockchain.direction} onclick={() => sortBlockchain.toggle("lastSync")}>{m.sources_last_sync()}</SortableHeader>
                                <Table.Head class="text-right">{m.label_actions()}</Table.Head>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {@const sortedBlockchainRows = sortBlockchain.key && sortBlockchain.direction ? sortItems(blockchainRows, blockchainAccessors[sortBlockchain.key], sortBlockchain.direction) : blockchainRows}
                            {#each sortedBlockchainRows as row}
                                {#if row.kind === "btc"}
                                    {@const account = row.data}
                                    {@const isSyncing = taskQueue.isActive(`btc-sync:${account.id}`)}
                                    <!-- BTC Mobile row -->
                                    <Table.Row class="sm:hidden">
                                        <Table.Cell colspan={99} class="py-2 px-3">
                                            <div class="flex items-start justify-between gap-2">
                                                <div class="min-w-0 flex-1">
                                                    <div class="flex items-center gap-1.5 flex-wrap">
                                                        <span class="font-mono text-sm truncate">{account.address_or_xpub.length > 16 ? `${account.address_or_xpub.slice(0, 10)}...${account.address_or_xpub.slice(-6)}` : account.address_or_xpub}</span>
                                                        <button onclick={() => copyToClipboard(account.address_or_xpub)} class="shrink-0 text-muted-foreground hover:text-foreground"><Copy class="h-3 w-3" /></button>
                                                        <Badge variant="secondary" class="gap-1 text-[10px]"><ChainIcon chainName="bitcoin" size={14} />{m.sources_bitcoin()}</Badge>
                                                    </div>
                                                    <div class="flex items-baseline gap-x-1.5 mt-0.5 text-xs text-muted-foreground">
                                                        {#if editingRowId === account.id}
                                                            <Input class="h-6 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("btc"); if (e.key === "Escape") editingRowId = null; }} />
                                                        {:else}
                                                            <span>{account.label}</span>
                                                        {/if}
                                                        <span class="ml-auto shrink-0">{account.last_sync ? new Date(account.last_sync).toLocaleDateString() : m.sources_never()}</span>
                                                    </div>
                                                </div>
                                                <div class="shrink-0">
                                                    <DropdownMenu.Root>
                                                        <DropdownMenu.Trigger>
                                                            {#snippet child({ props })}
                                                                <Button variant="ghost" size="icon-sm" {...props}><EllipsisVertical class="h-4 w-4" /></Button>
                                                            {/snippet}
                                                        </DropdownMenu.Trigger>
                                                        <DropdownMenu.Content align="end">
                                                            <DropdownMenu.Item disabled={btcBusy} onclick={() => syncBtcAccount(account)}><RefreshCw class="mr-2 h-4 w-4" />{m.sources_sync()}</DropdownMenu.Item>
                                                            <DropdownMenu.Item onclick={() => startEditLabel(account.id, account.label)}><Pencil class="mr-2 h-4 w-4" />{m.btn_rename()}</DropdownMenu.Item>
                                                            <DropdownMenu.Item disabled={btcBusy} onclick={() => handleRemoveBtcAccount(account.id)}><Trash2 class="mr-2 h-4 w-4" />{m.btn_delete()}</DropdownMenu.Item>
                                                        </DropdownMenu.Content>
                                                    </DropdownMenu.Root>
                                                </div>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                    <!-- BTC Desktop row -->
                                    <Table.Row class="hidden sm:table-row">
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {account.address_or_xpub.length > 20
                                                            ? `${account.address_or_xpub.slice(0, 12)}...${account.address_or_xpub.slice(-8)}`
                                                            : account.address_or_xpub}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{account.address_or_xpub}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(account.address_or_xpub)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === account.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("btc"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {account.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">
                                                {account.account_type === "address" ? m.sources_btc_address() : m.sources_hd_wallet()}
                                            </Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary" class="gap-1"><ChainIcon chainName="bitcoin" size={14} />{m.sources_bitcoin()}</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {account.last_sync
                                                ? new Date(account.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncBtcAccount(account)}
                                                    disabled={btcBusy || editingRowId === account.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === account.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === account.id ? (editingRowId = null) : startEditLabel(account.id, account.label)} disabled={btcBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveBtcAccount(account.id)}
                                                    disabled={btcBusy || editingRowId === account.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else}
                                    {@const chainConfig = getBlockchainConfig(row.kind)}
                                    {#if chainConfig}
                                        <BlockchainAccountRow
                                            config={chainConfig}
                                            account={row.data}
                                            syncing={taskQueue.isActive(`${chainConfig.syncTaskPrefix}:${row.data.id}`)}
                                            busy={isChainBusy(row.kind)}
                                            {editingRowId}
                                            {editingRowLabel}
                                            onSync={() => syncChainAccount(chainConfig, row.data)}
                                            onRemove={() => removeChainAccount(chainConfig, row.data.id)}
                                            onStartEdit={() => startEditLabel(row.data.id, row.data.label)}
                                            onCancelEdit={() => editingRowId = null}
                                            onSaveEdit={() => saveEditLabel(row.kind)}
                                            onEditLabelChange={(v) => editingRowLabel = v}
                                        />
                                    {:else}
                                        {@const group = row.data}
                                    {#if editingAddress === group.address}
                                        <!-- EVM Edit mode -->
                                        <Table.Row>
                                            <Table.Cell colspan={6}>
                                                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                                                <div
                                                    class="space-y-3 py-2"
                                                    role="form"
                                                    onkeydown={(e: KeyboardEvent) => {
                                                        if (e.key === "Escape") cancelEdit();
                                                    }}
                                                >
                                                    <div class="flex items-center gap-3">
                                                        <Tooltip.Root>
                                                            <Tooltip.Trigger class="font-mono text-sm text-muted-foreground">{formatAddress(group.address)}</Tooltip.Trigger>
                                                            <Tooltip.Content><p class="font-mono text-xs">{group.address}</p></Tooltip.Content>
                                                        </Tooltip.Root>
                                                        <button onclick={() => copyToClipboard(group.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy_address()}>
                                                            <Copy class="h-3 w-3" />
                                                        </button>
                                                        <div class="flex-1">
                                                            <Input placeholder={m.label_label()} bind:value={editLabel} />
                                                        </div>
                                                    </div>

                                                    <!-- Chain multi-select -->
                                                    <div class="space-y-2">
                                                        <span class="text-xs font-medium">{m.sources_chains()}</span>
                                                        <Popover.Root bind:open={editChainPopoverOpen}>
                                                            <Popover.Trigger>
                                                                <Button variant="outline" class="w-[300px] justify-between">
                                                                    {#if editChainIds.size === 0}
                                                                        {m.sources_select_chains()}
                                                                    {:else}
                                                                        {m.sources_chains_selected({ count: editChainIds.size })}
                                                                    {/if}
                                                                    <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                                                </Button>
                                                            </Popover.Trigger>
                                                            <Popover.Content class="w-[300px] p-0">
                                                                <Command.Root>
                                                                    <Command.Input placeholder={m.sources_search_chains()} />
                                                                    <Command.List>
                                                                        <Command.Empty>{m.sources_no_chain_found()}</Command.Empty>
                                                                        <Command.Group>
                                                                            {#each SUPPORTED_CHAINS as chain}
                                                                                <Command.Item
                                                                                    value={chain.name}
                                                                                    onSelect={() => toggleEditChain(chain.chain_id)}
                                                                                >
                                                                                    <Check
                                                                                        class={cn(
                                                                                            "mr-2 h-4 w-4",
                                                                                            editChainIds.has(chain.chain_id)
                                                                                                ? "opacity-100"
                                                                                                : "opacity-0",
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
                                                                        <button
                                                                            onclick={() => toggleEditChain(chain.chain_id)}
                                                                            class="ml-0.5 rounded-full outline-none hover:bg-muted"
                                                                        >
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
                                                            {savingEdit ? m.state_saving() : m.btn_save()}
                                                        </Button>
                                                        <Button variant="outline" size="sm" onclick={cancelEdit} disabled={savingEdit}>
                                                            {m.btn_cancel()}
                                                        </Button>
                                                    </div>
                                                </div>
                                            </Table.Cell>
                                        </Table.Row>
                                    {:else}
                                        <!-- EVM Display mode -->
                                        {@const isSyncingGroup = taskQueue.isActive(`etherscan-sync:${group.address}`)}
                                        <!-- EVM Mobile row -->
                                        <Table.Row class="sm:hidden">
                                            <Table.Cell colspan={99} class="py-2 px-3">
                                                <div class="flex items-start justify-between gap-2">
                                                    <div class="min-w-0 flex-1">
                                                        <div class="flex items-center gap-1.5 flex-wrap">
                                                            <span class="font-mono text-sm truncate">{formatAddress(group.address)}</span>
                                                            <button onclick={() => copyToClipboard(group.address)} class="shrink-0 text-muted-foreground hover:text-foreground"><Copy class="h-3 w-3" /></button>
                                                            <Badge variant="secondary" class="gap-1 text-[10px]"><ChainIcon chainId={1} size={14} />{m.sources_evm()}</Badge>
                                                        </div>
                                                        <div class="flex items-baseline gap-x-1.5 mt-0.5 text-xs text-muted-foreground">
                                                            <span>{group.label}</span>
                                                            {#if isSyncingGroup}
                                                                <RefreshCw class="inline h-3 w-3 animate-spin" />
                                                            {/if}
                                                        </div>
                                                        <div class="flex flex-wrap gap-0.5 mt-1">
                                                            {#each group.chainIds as chainId}
                                                                <Badge variant="secondary" class="gap-1 text-[10px]"><ChainIcon chainId={chainId} size={14} />{getChainName(chainId)}</Badge>
                                                            {/each}
                                                        </div>
                                                    </div>
                                                    <div class="shrink-0">
                                                        <DropdownMenu.Root>
                                                            <DropdownMenu.Trigger>
                                                                {#snippet child({ props })}
                                                                    <Button variant="ghost" size="icon-sm" {...props}><EllipsisVertical class="h-4 w-4" /></Button>
                                                                {/snippet}
                                                            </DropdownMenu.Trigger>
                                                            <DropdownMenu.Content align="end">
                                                                <DropdownMenu.Item disabled={ethBusy || reprocessing || applyingReprocess} onclick={() => handleSyncGroup(group)}><RefreshCw class="mr-2 h-4 w-4" />{m.sources_sync()}</DropdownMenu.Item>
                                                                <DropdownMenu.Item disabled={ethBusy || reprocessing || applyingReprocess} onclick={() => startEditAddress(group)}><Pencil class="mr-2 h-4 w-4" />{m.btn_rename()}</DropdownMenu.Item>
                                                                <DropdownMenu.Item disabled={ethBusy || reprocessing || applyingReprocess} onclick={() => handleRemoveGroup(group)}><Trash2 class="mr-2 h-4 w-4" />{m.btn_delete()}</DropdownMenu.Item>
                                                            </DropdownMenu.Content>
                                                        </DropdownMenu.Root>
                                                    </div>
                                                </div>
                                            </Table.Cell>
                                        </Table.Row>
                                        <!-- EVM Desktop row -->
                                        <Table.Row class="hidden sm:table-row">
                                            <Table.Cell class="font-mono text-sm">
                                                <div class="flex items-center gap-1">
                                                    <Tooltip.Root>
                                                        <Tooltip.Trigger class="truncate">{formatAddress(group.address)}</Tooltip.Trigger>
                                                        <Tooltip.Content><p class="font-mono text-xs">{group.address}</p></Tooltip.Content>
                                                    </Tooltip.Root>
                                                    <button onclick={() => copyToClipboard(group.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy_address()}>
                                                        <Copy class="h-3 w-3" />
                                                    </button>
                                                </div>
                                            </Table.Cell>
                                            <Table.Cell>{group.label}</Table.Cell>
                                            <Table.Cell>
                                                <Badge variant="secondary" class="gap-1"><ChainIcon chainId={1} size={14} />{m.sources_evm()}</Badge>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <div class="flex flex-wrap gap-1">
                                                    {#each group.chainIds as chainId}
                                                        <Badge variant="secondary" class="gap-1"><ChainIcon chainId={chainId} size={14} />{getChainName(chainId)}</Badge>
                                                    {/each}
                                                </div>
                                            </Table.Cell>
                                            <Table.Cell class="text-sm text-muted-foreground">--</Table.Cell>
                                            <Table.Cell class="text-right">
                                                <div class="flex justify-end gap-1">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onclick={() => handleSyncGroup(group)}
                                                        disabled={ethBusy || reprocessing || applyingReprocess}
                                                    >
                                                        <RefreshCw class="mr-1 h-3 w-3" />
                                                        {isSyncingGroup ? m.state_syncing() : m.sources_sync()}
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
                                {/if}
                                {/if}
                            {/each}
                        </Table.Body>
                    </Table.Root>
                </div>
            {/if}

            <!-- Exchanges sub-section -->
            {#if cexAccounts.length > 0}
                <div class="space-y-2">
                    <h4 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sources_exchanges()}</h4>
                    <Table.Root>
                        <Table.Header class="hidden sm:table-header-group">
                            <Table.Row>
                                <SortableHeader active={sortCex.key === "exchange"} direction={sortCex.direction} onclick={() => sortCex.toggle("exchange")}>{m.label_exchange()}</SortableHeader>
                                <SortableHeader active={sortCex.key === "label"} direction={sortCex.direction} onclick={() => sortCex.toggle("label")}>{m.label_label()}</SortableHeader>
                                <Table.Head class="hidden md:table-cell">{m.sources_opened_closed()}</Table.Head>
                                <SortableHeader active={sortCex.key === "lastSync"} direction={sortCex.direction} onclick={() => sortCex.toggle("lastSync")} class="hidden sm:table-cell">{m.sources_last_sync()}</SortableHeader>
                                <Table.Head class="text-right">{m.label_actions()}</Table.Head>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {@const sortedCexAccounts = sortCex.key && sortCex.direction ? sortItems(cexAccounts, cexAccessors[sortCex.key], sortCex.direction) : cexAccounts}
                            {#each sortedCexAccounts as account}
                                {@const isCexSyncing = taskQueue.queue.some((t) => t.key === `cex-sync:${account.id}` && t.status === "running")}
                                <!-- Mobile row -->
                                <Table.Row class="sm:hidden">
                                    <Table.Cell colspan={99} class="py-2 px-3">
                                        <div class="flex items-center justify-between gap-2">
                                            <div class="min-w-0 flex-1">
                                                <div class="flex items-center gap-2">
                                                    <Badge variant="secondary" class="shrink-0 gap-1 text-[10px]"><ExchangeIcon exchangeId={account.exchange} size={14} />{EXCHANGE_NAMES[account.exchange] ?? account.exchange}</Badge>
                                                    {#if editingRowId === account.id}
                                                        <Input class="h-7 text-xs flex-1" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("cex"); if (e.key === "Escape") editingRowId = null; }} />
                                                    {:else}
                                                        <span class="font-medium truncate">{account.label}</span>
                                                    {/if}
                                                </div>
                                                <div class="flex items-baseline gap-x-1.5 mt-0.5 text-xs text-muted-foreground">
                                                    {#if account.last_sync}
                                                        {new Date(account.last_sync).toLocaleDateString()}
                                                    {:else}
                                                        {m.sources_never()}
                                                    {/if}
                                                    {#if isCexSyncing}
                                                        <RefreshCw class="inline h-3 w-3 animate-spin" />
                                                    {/if}
                                                </div>
                                            </div>
                                            <div class="shrink-0">
                                                <DropdownMenu.Root>
                                                    <DropdownMenu.Trigger>
                                                        {#snippet child({ props })}
                                                            <Button variant="ghost" size="icon-sm" {...props}>
                                                                <EllipsisVertical class="h-4 w-4" />
                                                            </Button>
                                                        {/snippet}
                                                    </DropdownMenu.Trigger>
                                                    <DropdownMenu.Content align="end">
                                                        <DropdownMenu.Item
                                                            disabled={cexBusy || isAccountClosed(account)}
                                                            onclick={() => syncCex(account)}
                                                        >
                                                            <RefreshCw class="mr-2 h-4 w-4" />
                                                            {m.sources_sync()}
                                                        </DropdownMenu.Item>
                                                        <DropdownMenu.Item onclick={() => startEditLabel(account.id, account.label)}>
                                                            <Pencil class="mr-2 h-4 w-4" />
                                                            {m.btn_rename()}
                                                        </DropdownMenu.Item>
                                                        <DropdownMenu.Item onclick={() => removeCexAccount(account.id)}>
                                                            <Trash2 class="mr-2 h-4 w-4" />
                                                            {m.btn_delete()}
                                                        </DropdownMenu.Item>
                                                    </DropdownMenu.Content>
                                                </DropdownMenu.Root>
                                            </div>
                                        </div>
                                    </Table.Cell>
                                </Table.Row>
                                <!-- Desktop row -->
                                <Table.Row class="hidden sm:table-row">
                                    <Table.Cell>
                                        <Badge variant="secondary" class="gap-1"><ExchangeIcon exchangeId={account.exchange} size={14} />{EXCHANGE_NAMES[account.exchange] ?? account.exchange}</Badge>
                                    </Table.Cell>
                                    <Table.Cell class="font-medium">
                                        {#if editingRowId === account.id}
                                            <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("cex"); if (e.key === "Escape") editingRowId = null; }} />
                                        {:else}
                                            {account.label}
                                        {/if}
                                    </Table.Cell>
                                    <Table.Cell class="hidden md:table-cell">
                                        <div class="flex items-center gap-2">
                                            <input
                                                type="date"
                                                class="h-7 w-32 rounded border bg-transparent px-1 text-xs text-muted-foreground"
                                                value={account.opened_at ?? ""}
                                                onchange={(e) => {
                                                    const val = (e.target as HTMLInputElement).value || null;
                                                    getBackend().updateExchangeAccount(account.id, { opened_at: val });
                                                    account.opened_at = val;
                                                }}
                                                title={m.sources_opened_date()}
                                            />
                                            <span class="text-muted-foreground">—</span>
                                            <input
                                                type="date"
                                                class="h-7 w-32 rounded border bg-transparent px-1 text-xs text-muted-foreground"
                                                value={account.closed_at ?? ""}
                                                onchange={(e) => {
                                                    const val = (e.target as HTMLInputElement).value || null;
                                                    getBackend().updateExchangeAccount(account.id, { closed_at: val });
                                                    account.closed_at = val;
                                                }}
                                                title={m.sources_closed_date()}
                                            />
                                            {#if isAccountClosed(account)}
                                                <Badge variant="outline" class="text-muted-foreground">{m.sources_closed()}</Badge>
                                            {/if}
                                        </div>
                                    </Table.Cell>
                                    <Table.Cell class="hidden sm:table-cell">
                                        {#if account.last_sync}
                                            <span class="text-xs text-muted-foreground">{new Date(account.last_sync).toLocaleDateString()}</span>
                                        {:else}
                                            <span class="text-xs text-muted-foreground">{m.sources_never()}</span>
                                        {/if}
                                    </Table.Cell>
                                    <Table.Cell class="text-right">
                                        <div class="flex items-center justify-end gap-1">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={cexBusy || isAccountClosed(account) || editingRowId === account.id}
                                                onclick={() => syncCex(account)}
                                            >
                                                <RefreshCw class="mr-1 h-3 w-3 {isCexSyncing ? 'animate-spin' : ''}" />
                                                {isCexSyncing ? m.state_syncing() : m.sources_sync()}
                                            </Button>
                                            <Button variant={editingRowId === account.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === account.id ? (editingRowId = null) : startEditLabel(account.id, account.label)}>
                                                <Pencil class="h-3 w-3" />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={editingRowId === account.id}
                                                onclick={() => removeCexAccount(account.id)}
                                            >
                                                <Trash2 class="h-3 w-3" />
                                            </Button>
                                        </div>
                                    </Table.Cell>
                                </Table.Row>
                            {/each}
                        </Table.Body>
                    </Table.Root>
                </div>
            {/if}

            <!-- Empty state -->
            {#if cexAccounts.length === 0 && blockchainRows.length === 0}
                <p class="text-sm text-muted-foreground">{m.empty_no_online_sources()}</p>
            {/if}
        </Card.Content>

        <!-- Footer with unified actions -->
        {#if cexAccounts.length > 0 || blockchainRows.length > 0}
            <Card.Footer class="flex flex-wrap justify-end gap-2">
                {#if ethAccounts.length > 0 && cexAccounts.length > 0}
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={cexBusy || cexConsolidating}
                        onclick={handleConsolidateCex}
                    >
                        <Link2 class="mr-1 h-4 w-4" />
                        {cexConsolidating ? m.state_consolidating() : m.sources_consolidate()}
                    </Button>
                {/if}
                {#if ethAccounts.length > 0}
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={handleReprocessAll}
                        disabled={ethBusy || reprocessing || applyingReprocess || ethAccounts.length === 0}
                    >
                        <RotateCw class="mr-1 h-4 w-4" />
                        {taskQueue.isActive("reprocess-dryrun:all") ? m.state_scanning() : m.btn_reprocess_all()}
                    </Button>
                {/if}
                <Button
                    size="sm"
                    onclick={syncAll}
                    disabled={anyBusy || reprocessing || applyingReprocess}
                >
                    <RefreshCw class="mr-1 h-4 w-4 {anyBusy ? 'animate-spin' : ''}" />
                    {anyBusy ? m.state_syncing() : m.sources_sync_all()}
                </Button>
            </Card.Footer>
        {/if}
    </Card.Root>

    <!-- Categorization Rules -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{m.sources_categorization_rules()}</Card.Title>
            <Card.Description>
                {m.sources_categorization_rules_desc()}
            </Card.Description>
        </Card.Header>
        <Card.Content>
            <CategorizationRulesEditor
                rules={categorizationRules}
                onchange={(updated) => {
                    categorizationRules = updated;
                    settings.update({ csvCategorizationRules: updated });
                    setBankStatementRules(updated);
                    setRevolutRules(updated);
                    setLaBanquePostaleRules(updated);
                    setN26Rules(updated);
                }}
                collapsible={false}
                maxHeight="max-h-80"
            />
        </Card.Content>
    </Card.Root>

    <!-- Transaction Handlers -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{m.sources_transaction_handlers()}</Card.Title>
            <Card.Description
                >{m.sources_transaction_handlers_desc({ count: handlers.length })}</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-medium">{m.sources_api_enrichment()}</p>
                    <p class="text-sm text-muted-foreground">
                        {m.sources_api_enrichment_desc()}
                    </p>
                </div>
                <Switch
                    checked={settings.settings.enrichmentEnabled ?? false}
                    onCheckedChange={(v) => {
                        settings.update({ enrichmentEnabled: v });
                        suggestReprocess();
                    }}
                />
            </div>
            <div class="mt-4 border-t pt-4">
                <Collapsible.Root>
                    <Collapsible.Trigger class="flex w-full items-center justify-between text-sm font-medium hover:text-foreground/80 transition-colors">
                        <span>{m.sources_supported_protocols({ count: protocolInfos.length })}</span>
                        <ChevronsUpDown class="h-3.5 w-3.5 text-muted-foreground" />
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                        <div class="mt-2">
                            <Input
                                type="text"
                                placeholder={m.sources_filter_protocols()}
                                class="mb-2 h-8 text-sm"
                                bind:value={protocolFilter}
                            />
                            <div class="flex flex-col gap-1">
                                {#each filteredProtocolInfos() as proto}
                                    <Collapsible.Root>
                                        <Collapsible.Trigger class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors">
                                            <div class="flex items-center gap-2">
                                                <span class="font-medium">{proto.name}</span>
                                                <span class="text-xs text-muted-foreground">{m.sources_network_count({ count: proto.chains.length })}</span>
                                            </div>
                                            <ChevronsUpDown class="h-3.5 w-3.5 text-muted-foreground" />
                                        </Collapsible.Trigger>
                                        <Collapsible.Content>
                                            <div class="px-2 pb-2 pt-1 space-y-2 text-sm">
                                                <p class="text-muted-foreground">{proto.description}</p>
                                                {#if proto.website}
                                                    <a href={proto.website} target="_blank" rel="noopener noreferrer"
                                                       class="text-xs text-blue-500 hover:underline">{proto.website}</a>
                                                {/if}
                                                <div class="flex flex-wrap gap-1">
                                                    {#each proto.chains as chain}
                                                        <Badge variant="outline">{chain}</Badge>
                                                    {/each}
                                                </div>
                                                {#if proto.contracts.length > 0}
                                                    <div class="text-xs text-muted-foreground space-y-0.5">
                                                        {#each proto.contracts as c}
                                                            <div><span class="font-medium">{c.label}:</span> <code class="text-[11px]">{c.address}</code></div>
                                                        {/each}
                                                    </div>
                                                {/if}
                                            </div>
                                        </Collapsible.Content>
                                    </Collapsible.Root>
                                {/each}
                            </div>
                        </div>
                    </Collapsible.Content>
                </Collapsible.Root>
            </div>
        </Card.Content>
    </Card.Root>

</div>

<AddOnlineSourceDialog
    bind:open={addDialogOpen}
    existingCexAccounts={cexAccounts}
    existingEthAccounts={ethAccounts}
    existingBtcAccounts={btcAccounts}
    {chainStates}
    onAccountAdded={handleAccountAdded}
/>
