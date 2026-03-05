<script lang="ts">
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
    import { readFileAsText } from "$lib/utils/read-file-text.js";
    import { unzipSync, strFromU8 } from "fflate";
    import { filterLedgerFiles, resolveIncludes } from "$lib/ledger-include.js";
    import { detectImportTarget } from "$lib/import-detect.js";
    import {
        enqueueRateBackfill,
    } from "$lib/exchange-rate-historical.js";
    import type { ChainInfo, EtherscanAccount } from "$lib/types/index.js";
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
    import {
        getCexAdapter,
        syncCexAccount,
        retroactiveConsolidate,
    } from "$lib/cex/index.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import Link2 from "lucide-svelte/icons/link-2";
    import CsvImportDialog from "$lib/components/CsvImportDialog.svelte";
    import OfxImportDialog from "$lib/components/OfxImportDialog.svelte";
    import PdfImportDialog from "$lib/components/PdfImportDialog.svelte";
    import LedgerImportDialog from "$lib/components/LedgerImportDialog.svelte";
    import SortableHeader from "$lib/components/SortableHeader.svelte";
    import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
    import AddSourceInput from "$lib/components/AddSourceInput.svelte";
    import type { ExchangeId } from "$lib/cex/types.js";

    let csvDialogOpen = $state(false);
    let csvInitialContent = $state("");
    let csvInitialFileName = $state("");

    let ofxDialogOpen = $state(false);
    let ofxInitialContent = $state("");
    let ofxInitialFileName = $state("");

    let pdfDialogOpen = $state(false);
    let pdfInitialFile = $state<File | null>(null);
    let pdfInitialFileName = $state("");

    let ledgerDialogOpen = $state(false);
    let ledgerInitialContent = $state("");
    let ledgerInitialFileName = $state("");

    let importDragCounter = $state(0);
    let dragging = $derived(importDragCounter > 0);
    let fileInputEl = $state<HTMLInputElement | null>(null);

    // Clear initial content when dialogs close
    $effect(() => {
        if (!ledgerDialogOpen) {
            ledgerInitialContent = "";
            ledgerInitialFileName = "";
        }
    });

    $effect(() => {
        if (!csvDialogOpen) {
            csvInitialContent = "";
            csvInitialFileName = "";
        }
    });

    $effect(() => {
        if (!ofxDialogOpen) {
            ofxInitialContent = "";
            ofxInitialFileName = "";
        }
    });

    $effect(() => {
        if (!pdfDialogOpen) {
            pdfInitialFile = null;
            pdfInitialFileName = "";
        }
    });

    async function routeFile(file: File) {
        const result = await detectImportTarget(file);
        if (!result) {
            toast.error("Unsupported file format");
            return;
        }

        switch (result.target) {
            case "csv":
                csvInitialContent = result.text ?? await readFileAsText(file);
                csvInitialFileName = file.name;
                csvDialogOpen = true;
                break;
            case "ofx":
                ofxInitialContent = result.text ?? await readFileAsText(file);
                ofxInitialFileName = file.name;
                ofxDialogOpen = true;
                break;
            case "pdf":
                pdfInitialFile = file;
                pdfInitialFileName = file.name;
                pdfDialogOpen = true;
                break;
            case "ledger":
                if (result.bytes && file.name.toLowerCase().endsWith(".zip")) {
                    try {
                        const entries = unzipSync(result.bytes);
                        const fileMap = new Map<string, string>();
                        for (const [name, data] of Object.entries(entries)) {
                            fileMap.set(name, strFromU8(data));
                        }
                        const ledgerFiles = filterLedgerFiles(fileMap);
                        if (ledgerFiles.length === 0) {
                            toast.error("No ledger files found in archive");
                            return;
                        }
                        const parts: string[] = [];
                        for (const [, content] of ledgerFiles) {
                            parts.push(resolveIncludes(content, fileMap));
                        }
                        ledgerInitialContent = parts.join("\n\n");
                    } catch (err) {
                        toast.error(`Failed to read zip: ${err}`);
                        return;
                    }
                } else {
                    ledgerInitialContent = result.text ?? await readFileAsText(file);
                }
                ledgerInitialFileName = file.name;
                ledgerDialogOpen = true;
                break;
        }
    }

    function handleImportClick() {
        fileInputEl?.click();
    }

    async function handleFileInputChange(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) await routeFile(file);
        input.value = "";
    }

    async function handleFileDrop(e: DragEvent) {
        e.preventDefault();
        importDragCounter = 0;
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        if (files.length > 1) {
            toast.error("Please drop only one file at a time");
            return;
        }
        await routeFile(files[0]);
    }

    const handlerRegistry = getDefaultRegistry();
    const handlers = handlerRegistry.getAll();

    const settings = new SettingsStore();

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

    type AddSourceMode = "idle" | "cex" | "blockchain";
    let addSourceMode = $state<AddSourceMode>("idle");
    let addSourceExchangeId = $state<ExchangeId>("kraken");
    let cexNewLabel = $state("");
    let cexNewApiKey = $state("");
    let cexNewApiSecret = $state("");
    let cexNewPassphrase = $state("");
    let cexAdding = $state(false);
    const cexBusy = $derived(taskQueue.isActive("cex-sync"));
    const cexConsolidating = $derived(taskQueue.isActive("cex-consolidate"));

    const EXCHANGE_NAMES: Record<ExchangeId, string> = {
        kraken: "Kraken", binance: "Binance", coinbase: "Coinbase",
        bybit: "Bybit", okx: "OKX", bitstamp: "Bitstamp", cryptocom: "Crypto.com",
        volet: "Volet",
    };

    function startAddCex(exchangeId: ExchangeId) {
        addSourceMode = "cex";
        addSourceExchangeId = exchangeId;
    }

    function startAddBlockchain(prefillAddress?: string) {
        addSourceMode = "blockchain";
        if (prefillAddress) newAddress = prefillAddress;
    }

    function cancelAdd() {
        addSourceMode = "idle";
        cexNewLabel = "";
        cexNewApiKey = "";
        cexNewApiSecret = "";
        cexNewPassphrase = "";
        newAddress = "";
        newLabel = "";
        selectedChainIds = new Set([1]);
    }

    const anyBusy = $derived(cexBusy || ethBusy);

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
                exchange: addSourceExchangeId,
                label: cexNewLabel,
                api_key: cexNewApiKey,
                api_secret: cexNewApiSecret,
                passphrase: cexNewPassphrase || null,
                last_sync: null,
                created_at: new Date().toISOString(),
            };
            await getBackend().addExchangeAccount(account);
            cancelAdd();
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
                        {
                            baseCurrency: settings.currency,
                            coingeckoApiKey: settings.coingeckoApiKey,
                            coingeckoPro: settings.settings.coingeckoPro,
                            finnhubApiKey: settings.finnhubApiKey,
                            cryptoCompareApiKey: settings.cryptoCompareApiKey,
                            dpriceMode: settings.settings.dpriceMode,
                            dpriceUrl: settings.settings.dpriceUrl,
                        },
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
    });

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
            cancelAdd();
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

    function syncEthAccount(account: EtherscanAccount) {
        if (settings.settings.etherscanEnabled === false) {
            toast.error("Etherscan is disabled in Settings");
            return;
        }
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
                        {
                            baseCurrency: settings.currency,
                            coingeckoApiKey: settings.coingeckoApiKey,
                            coingeckoPro: settings.settings.coingeckoPro,
                            finnhubApiKey: settings.finnhubApiKey,
                            cryptoCompareApiKey: settings.cryptoCompareApiKey,
                            dpriceMode: settings.settings.dpriceMode,
                            dpriceUrl: settings.settings.dpriceUrl,
                        },
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

    function syncAll() {
        for (const account of cexAccounts) syncCex(account);
        if (settings.etherscanApiKey && ethAccounts.length > 0) {
            for (const account of ethAccounts) syncEthAccount(account);
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
    <div>
        <h1 class="text-2xl font-bold tracking-tight">Sources</h1>
        <p class="text-muted-foreground">
            Import data from ledger files or sync transactions from external
            sources.
        </p>
    </div>

    <!-- Import Files -->
    <Card.Root
        class={dragging
            ? "outline-2 outline-dashed outline-primary -outline-offset-2 bg-accent/50 transition-colors"
            : "transition-colors"}
        ondragenter={(e: DragEvent) => {
            e.preventDefault();
            importDragCounter++;
        }}
        ondragover={(e: DragEvent) => {
            e.preventDefault();
        }}
        ondragleave={() => {
            importDragCounter--;
        }}
        ondrop={handleFileDrop}
    >
        <Card.Header>
            <Card.Title>Import Files</Card.Title>
            <Card.Description>
                Import transactions from files. Drop a file or click to choose.
                <span class="mt-2 flex flex-col gap-1.5">
                    <span class="flex flex-wrap items-center gap-1">
                        <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">CSV</span>
                        {#each ["Binance", "Bisq", "Bitfinex", "Bitstamp", "Bittrex", "Bybit", "Coinbase", "CoinList", "Crypto.com", "Gate.io", "Kraken", "La Banque Postale", "N26", "Nexo", "Poloniex", "Revolut", "Yield App"] as name}
                            <Badge variant="outline">{name}</Badge>
                        {/each}
                    </span>
                    <span class="flex flex-wrap items-center gap-1">
                        <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">OFX / QFX / QBO</span>
                    </span>
                    <span class="flex flex-wrap items-center gap-1">
                        <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">PDF</span>
                        {#each ["Deblock", "La Banque Postale", "N26", "Nuri/Bitwala"] as name}
                            <Badge variant="outline">{name}</Badge>
                        {/each}
                    </span>
                    <span class="flex flex-wrap items-center gap-1">
                        <span class="text-xs font-medium text-muted-foreground/70 mr-0.5">Plain-Text</span>
                        {#each ["Beancount", "hledger", "ledger"] as name}
                            <Badge variant="outline">{name}</Badge>
                        {/each}
                    </span>
                </span>
            </Card.Description>
        </Card.Header>
        <Card.Content>
            <div class="flex items-center gap-3">
                <Button onclick={handleImportClick}>
                    <Upload class="mr-2 h-4 w-4" /> Import File
                </Button>
                <input
                    bind:this={fileInputEl}
                    type="file"
                    accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo,.pdf,.ledger,.beancount,.journal,.hledger,.dat,.zip"
                    class="hidden"
                    onchange={handleFileInputChange}
                />
                {#if dragging}
                    <p class="text-sm text-muted-foreground">
                        Drop file to import...
                    </p>
                {/if}
            </div>
        </Card.Content>
    </Card.Root>

    <LedgerImportDialog
        bind:open={ledgerDialogOpen}
        initialContent={ledgerInitialContent}
        initialFileName={ledgerInitialFileName}
    />
    <CsvImportDialog
        bind:open={csvDialogOpen}
        initialContent={csvInitialContent}
        initialFileName={csvInitialFileName}
    />
    <OfxImportDialog
        bind:open={ofxDialogOpen}
        initialContent={ofxInitialContent}
        initialFileName={ofxInitialFileName}
    />
    <PdfImportDialog
        bind:open={pdfDialogOpen}
        initialFile={pdfInitialFile}
        initialFileName={pdfInitialFileName}
    />

    <!-- Online Sources -->
    <Card.Root>
        <Card.Header>
            <Card.Title>Online Sources</Card.Title>
            <Card.Description>Sync data from exchanges and blockchains.</Card.Description>
        </Card.Header>
        <Card.Content class="space-y-6">
            <!-- Smart input / Add forms -->
            {#if addSourceMode === "idle"}
                <AddSourceInput
                    onSelectCex={startAddCex}
                    onSelectBlockchain={startAddBlockchain}
                    disabled={anyBusy}
                />
            {:else if addSourceMode === "cex"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <Badge variant="secondary">{EXCHANGE_NAMES[addSourceExchangeId]}</Badge>
                            <span class="text-sm font-medium">Add Exchange Account</span>
                        </div>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <Input
                        class="w-full sm:w-60"
                        placeholder="Label (e.g., Main)"
                        bind:value={cexNewLabel}
                    />
                    <div class="flex flex-wrap gap-2">
                        <Input
                            class="w-full sm:flex-1"
                            type="password"
                            placeholder={addSourceExchangeId === "coinbase"
                                ? "API Key Name"
                                : addSourceExchangeId === "volet"
                                ? "API Name"
                                : "API Key"}
                            bind:value={cexNewApiKey}
                        />
                        <Input
                            class="w-full sm:flex-1"
                            type="password"
                            placeholder={addSourceExchangeId === "coinbase"
                                ? "EC Private Key (PEM)"
                                : addSourceExchangeId === "volet"
                                ? "Security Word"
                                : "API Secret"}
                            bind:value={cexNewApiSecret}
                        />
                    </div>
                    {#if getCexAdapter(addSourceExchangeId).requiresPassphrase}
                        <Input
                            class="w-full sm:w-64"
                            type="password"
                            placeholder={addSourceExchangeId === "volet" ? "Account Email" : "API Passphrase"}
                            bind:value={cexNewPassphrase}
                        />
                    {/if}
                    <Button size="sm" disabled={cexAdding} onclick={addCexAccount}>
                        <Plus class="mr-1 h-4 w-4" />
                        Add Account
                    </Button>
                </div>
            {:else if addSourceMode === "blockchain"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add EVM Address</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
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
                            disabled={addingAccount ||
                                !newAddress.trim() ||
                                !newLabel.trim() ||
                                selectedChainIds.size === 0}
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
                                <Button
                                    variant="outline"
                                    class="w-[300px] justify-between"
                                >
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
                                                            selectedChainIds.has(chain.chain_id)
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

                        {#if selectedChainIds.size > 0}
                            <div class="flex flex-wrap gap-1">
                                {#each SUPPORTED_CHAINS.filter((c) => selectedChainIds.has(c.chain_id)) as chain}
                                    <Badge variant="secondary" class="gap-1">
                                        {chain.name}
                                        <button
                                            onclick={() => toggleChain(chain.chain_id)}
                                            class="ml-0.5 rounded-full outline-none hover:bg-muted"
                                        >
                                            <X class="h-3 w-3" />
                                        </button>
                                    </Badge>
                                {/each}
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            <!-- Exchanges sub-section -->
            {#if cexAccounts.length > 0}
                <div class="space-y-2">
                    <h4 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Exchanges</h4>
                    <Table.Root>
                        <Table.Header>
                            <Table.Row>
                                <SortableHeader active={sortCex.key === "exchange"} direction={sortCex.direction} onclick={() => sortCex.toggle("exchange")}>Exchange</SortableHeader>
                                <SortableHeader active={sortCex.key === "label"} direction={sortCex.direction} onclick={() => sortCex.toggle("label")}>Label</SortableHeader>
                                <SortableHeader active={sortCex.key === "lastSync"} direction={sortCex.direction} onclick={() => sortCex.toggle("lastSync")} class="hidden sm:table-cell">Last Sync</SortableHeader>
                                <Table.Head class="text-right">Actions</Table.Head>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {@const sortedCexAccounts = sortCex.key && sortCex.direction ? sortItems(cexAccounts, cexAccessors[sortCex.key], sortCex.direction) : cexAccounts}
                            {#each sortedCexAccounts as account}
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
                                                <RefreshCw
                                                    class="h-4 w-4 {taskQueue.queue.some(
                                                        (t) =>
                                                            t.key === `cex-sync:${account.id}` &&
                                                            t.status === 'running',
                                                    )
                                                        ? 'animate-spin'
                                                        : ''}"
                                                />
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
                </div>
            {/if}

            <!-- Blockchain Addresses sub-section -->
            {#if groupedAddresses.length > 0}
                <div class="space-y-2">
                    <div class="flex items-center justify-between">
                        <h4 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Blockchain Addresses</h4>
                        <span class="text-xs text-muted-foreground">
                            API keys: <a href="/settings" class="underline hover:text-foreground">Settings</a>
                            {#if !settings.etherscanApiKey}
                                <span class="text-amber-600 dark:text-amber-400 ml-1">(not set)</span>
                            {/if}
                        </span>
                    </div>
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
                                                onkeydown={(e: KeyboardEvent) => {
                                                    if (e.key === "Escape") cancelEdit();
                                                }}
                                            >
                                                <div class="flex items-center gap-3">
                                                    <span class="font-mono text-sm text-muted-foreground">{formatAddress(group.address)}</span>
                                                    <div class="flex-1">
                                                        <Input placeholder="Label" bind:value={editLabel} />
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
                </div>
            {/if}

            <!-- Empty state -->
            {#if cexAccounts.length === 0 && groupedAddresses.length === 0 && addSourceMode === "idle"}
                <p class="text-sm text-muted-foreground">No online sources configured yet.</p>
            {/if}
        </Card.Content>

        <!-- Footer with unified actions -->
        {#if cexAccounts.length > 0 || ethAccounts.length > 0}
            <Card.Footer class="flex justify-end gap-2">
                {#if ethAccounts.length > 0 && cexAccounts.length > 0}
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
                {#if ethAccounts.length > 0}
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={handleReprocessAll}
                        disabled={ethBusy || reprocessing || applyingReprocess || ethAccounts.length === 0}
                    >
                        <RotateCw class="mr-1 h-4 w-4" />
                        {taskQueue.isActive("reprocess-dryrun:all") ? "Scanning..." : "Reprocess All"}
                    </Button>
                {/if}
                <Button
                    size="sm"
                    onclick={syncAll}
                    disabled={anyBusy || reprocessing || applyingReprocess}
                >
                    <RefreshCw class="mr-1 h-4 w-4 {anyBusy ? 'animate-spin' : ''}" />
                    {anyBusy ? "Syncing..." : "Sync All"}
                </Button>
            </Card.Footer>
        {/if}
    </Card.Root>

    <!-- Transaction Handlers -->
    <Card.Root>
        <Card.Header>
            <Card.Title>Transaction Handlers</Card.Title>
            <Card.Description
                >Enable protocol-specific handlers for richer transaction
                interpretation.</Card.Description
            >
        </Card.Header>
        <Card.Content>
            <Table.Root>
                <Table.Header>
                    <Table.Row>
                        <Table.Head>Handler</Table.Head>
                        <Table.Head class="hidden md:table-cell"
                            >Description</Table.Head
                        >
                        <Table.Head class="hidden lg:table-cell"
                            >Chains</Table.Head
                        >
                        <Table.Head class="text-right hidden sm:table-cell"
                            >Enrichment</Table.Head
                        >
                        <Table.Head class="text-right">Enabled</Table.Head>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {#each handlers as handler}
                        {@const isGeneric = handler.id === "generic-etherscan"}
                        {@const isEnabled =
                            isGeneric ||
                            settings.settings.handlers[handler.id]?.enabled}
                        <Table.Row>
                            <Table.Cell class="font-medium"
                                >{handler.name}</Table.Cell
                            >
                            <Table.Cell
                                class="text-muted-foreground hidden md:table-cell"
                                >{handler.description}</Table.Cell
                            >
                            <Table.Cell class="hidden lg:table-cell">
                                {#if handler.supportedChainIds.length === 0}
                                    <Badge variant="secondary">All chains</Badge
                                    >
                                {:else}
                                    <div class="flex flex-wrap gap-1">
                                        {#each handler.supportedChainIds as chainId}
                                            <Badge variant="secondary"
                                                >{getChainName(chainId)}</Badge
                                            >
                                        {/each}
                                    </div>
                                {/if}
                            </Table.Cell>
                            {@const hasEnrichment = [
                                "uniswap",
                                "aave",
                                "lido",
                                "curve",
                                "pendle",
                                "compound",
                                "yearn",
                                "balancer",
                                "maker",
                            ].includes(handler.id)}
                            {@const enrichmentEnabled =
                                settings.settings.handlers[handler.id]
                                    ?.enrichment ?? false}
                            <Table.Cell class="text-right hidden sm:table-cell">
                                {#if hasEnrichment && !isGeneric}
                                    <Switch
                                        checked={enrichmentEnabled}
                                        disabled={!isEnabled}
                                        onCheckedChange={(v) => {
                                            const current = {
                                                ...settings.settings.handlers,
                                            };
                                            const prev = current[
                                                handler.id
                                            ] ?? { enabled: false };
                                            current[handler.id] = {
                                                ...prev,
                                                enrichment: v,
                                            };
                                            settings.update({
                                                handlers: current,
                                            });
                                            suggestReprocess();
                                        }}
                                    />
                                {:else}
                                    <span class="text-sm text-muted-foreground"
                                        >--</span
                                    >
                                {/if}
                            </Table.Cell>
                            <Table.Cell class="text-right">
                                {#if isGeneric}
                                    <span class="text-sm text-muted-foreground"
                                        >Always enabled</span
                                    >
                                {:else}
                                    <Switch
                                        checked={isEnabled ?? false}
                                        onCheckedChange={(v) => {
                                            const current = {
                                                ...settings.settings.handlers,
                                            };
                                            current[handler.id] = {
                                                ...current[handler.id],
                                                enabled: v,
                                            };
                                            settings.update({
                                                handlers: current,
                                            });
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

</div>
