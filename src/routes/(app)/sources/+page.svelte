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
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
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
    import { detectSolInputType as detectSolInputTypeJs } from "$lib/solana/derive-js.js";
    import { deriveSolAddresses as deriveSolAddressesJs } from "$lib/solana/derive-js.js";
    import type { SolanaAccount } from "$lib/solana/types.js";
    import type { HyperliquidAccount } from "$lib/hyperliquid/types.js";
    import type { DerivedSolAddress } from "$lib/solana/derive-js.js";
    import type { DerivedBtcXpub } from "$lib/bitcoin/derive.js";
    import type { ExchangeAccount } from "$lib/cex/types.js";
    import {
        getCexAdapter,
        syncCexAccount,
        retroactiveConsolidate,
    } from "$lib/cex/index.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import Link2 from "lucide-svelte/icons/link-2";
    import SortableHeader from "$lib/components/SortableHeader.svelte";
    import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
    import AddSourceInput from "$lib/components/AddSourceInput.svelte";
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

    const csvPresetNames = getDefaultPresetRegistry().getAll()
        .filter(p => p.id !== "bank-statement")
        .map(p => p.name);
    const pdfParserNames = getPluginManager().pdfParsers.getAll()
        .map(p => p.name);

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
    let selectedChainIds = $state<Set<number>>(new Set([1]));
    let chainPopoverOpen = $state(false);
    let newAddress = $state("");
    let newLabel = $state("");
    let addingAccount = $state(false);
    let evmPrivateKeyAck = $state(false);
    let evmSeedPassphrase = $state("");
    let evmDeriveCount = $state(5);
    let evmSelectedIndexes = $state<Set<number>>(new Set([0]));
    let evmItemLabels = $state<Map<number, string>>(new Map());
    const ethBusy = $derived(taskQueue.isActive("etherscan-sync"));

    // -- Inline label edit state (BTC/SOL/HL/CEX) --
    let editingRowId = $state<string | null>(null);
    let editingRowLabel = $state("");

    function startEditLabel(id: string, currentLabel: string) {
        editingRowId = id;
        editingRowLabel = currentLabel;
    }

    async function saveEditLabel(kind: "btc" | "sol" | "hl" | "cex") {
        if (!editingRowId) return;
        const label = editingRowLabel.trim();
        if (!label) { editingRowId = null; return; }
        try {
            if (kind === "btc") {
                await getBackend().updateBitcoinAccountLabel(editingRowId, label);
                await loadBtcAccounts();
            } else if (kind === "sol") {
                await getBackend().updateSolanaAccountLabel(editingRowId, label);
                await loadSolAccounts();
            } else if (kind === "hl") {
                await getBackend().updateHyperliquidAccountLabel(editingRowId, label);
                await loadHlAccounts();
            } else if (kind === "cex") {
                await getBackend().updateExchangeAccount(editingRowId, { label });
                await loadCexAccounts();
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

    // Merged blockchain rows (BTC + EVM + SOL + HL)
    type BlockchainRow =
        | { kind: "btc"; data: import("$lib/bitcoin/types.js").BitcoinAccount }
        | { kind: "evm"; data: GroupedAddress }
        | { kind: "sol"; data: SolanaAccount }
        | { kind: "hl"; data: HyperliquidAccount };

    const blockchainRows = $derived.by((): BlockchainRow[] => {
        const rows: BlockchainRow[] = [];
        for (const account of btcAccounts) rows.push({ kind: "btc", data: account });
        for (const group of groupedAddresses) rows.push({ kind: "evm", data: group });
        for (const account of solAccounts) rows.push({ kind: "sol", data: account });
        for (const account of hlAccounts) rows.push({ kind: "hl", data: account });
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
    const blockchainAccessors: Record<BlockchainSortKey, SortAccessor<BlockchainRow>> = {
        address: (r) => r.kind === "btc" ? r.data.address_or_xpub : r.kind === "sol" ? r.data.address : r.kind === "hl" ? r.data.address : r.data.address,
        label: (r) => r.data.label,
        type: (r) => r.kind === "btc"
            ? (r.data.account_type === "address" ? "BTC Address" : "HD Wallet")
            : r.kind === "sol" ? "Solana" : r.kind === "hl" ? "Hyperliquid" : "EVM",
        networks: (r) => r.kind === "btc"
            ? "Bitcoin"
            : r.kind === "sol" ? "Solana" : r.kind === "hl" ? "Hyperliquid" : r.data.chainIds.map((id) => getChainName(id)).join(", "),
        lastSync: (r) => r.kind === "btc" ? (r.data.last_sync || "") : r.kind === "sol" ? (r.data.last_sync || "") : r.kind === "hl" ? (r.data.last_sync || "") : "",
    };

    function isAccountClosed(account: ExchangeAccount): boolean {
        if (!account.closed_at) return false;
        return account.closed_at < new Date().toISOString().slice(0, 10);
    }

    type AddSourceMode = "idle" | "cex" | "blockchain" | "bitcoin" | "solana" | "hyperliquid";
    let addSourceMode = $state<AddSourceMode>("idle");
    let addSourceExchangeId = $state<ExchangeId>("kraken");
    let cexNewLabel = $state("");
    let cexNewApiKey = $state("");
    let cexNewApiSecret = $state("");
    let cexNewPassphrase = $state("");
    let cexNewOpenedAt = $state("");
    let cexNewClosedAt = $state("");
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
        cexNewOpenedAt = "";
        cexNewClosedAt = "";
        newAddress = "";
        newLabel = "";
        selectedChainIds = new Set([1]);
        btcNewAddressOrXpub = "";
        btcNewLabel = "";
        btcPrivateKeyAck = false;
        btcSeedBip = 84;
        btcSeedPassphrase = "";
        btcDeriveCount = 5;
        btcSelectedIndexes = new Set([0]);
        btcDerivedXpubs = [];
        btcDeriving = false;
        evmPrivateKeyAck = false;
        evmSeedPassphrase = "";
        evmDeriveCount = 5;
        evmSelectedIndexes = new Set([0]);
        evmItemLabels = new Map();
        btcItemLabels = new Map();
    }

    // -- Bitcoin state --
    let btcAccounts = $state<import("$lib/bitcoin/types.js").BitcoinAccount[]>([]);
    let btcNewAddressOrXpub = $state("");
    let btcNewLabel = $state("");
    let btcPrivateKeyAck = $state(false);
    let btcSeedBip = $state(84);
    let btcSeedPassphrase = $state("");
    let btcAddingAccount = $state(false);
    let btcDeriveCount = $state(5);
    let btcSelectedIndexes = $state<Set<number>>(new Set([0]));
    let btcItemLabels = $state<Map<number, string>>(new Map());
    let btcDerivedXpubs = $state<import("$lib/bitcoin/derive-js.js").DerivedBtcXpub[]>([]);
    let btcDeriving = $state(false);

    // Hyperliquid state
    let hlAccounts = $state<HyperliquidAccount[]>([]);
    let hlNewAddress = $state("");
    let hlNewLabel = $state("");
    let hlAddingAccount = $state(false);
    const hlBusy = $derived(taskQueue.isActive("hl-sync"));

    // Solana state
    let solAccounts = $state<SolanaAccount[]>([]);
    let solNewAddress = $state("");
    let solNewLabel = $state("");
    let solPrivateKeyAck = $state(false);
    let solAddingAccount = $state(false);
    let solDeriveCount = $state(5);
    let solSelectedIndexes = $state<Set<number>>(new Set([0]));
    let solItemLabels = $state<Map<number, string>>(new Map());
    let solDerivedAddresses = $state<DerivedSolAddress[]>([]);
    let solDeriving = $state(false);

    const btcDetection: QuickDetection = $derived.by(() => detectInputType(btcNewAddressOrXpub));
    const evmDetection = $derived.by(() => detectEvmInputType(newAddress));
    const evmDerivedAddresses = $derived.by(() => {
        const input = newAddress.trim();
        if (!input) return [];
        const det = evmDetection;
        if (det.type === "seed") {
            if (!evmPrivateKeyAck) return [];
            const v = validateEvmSeedPhrase(input);
            if (!v.valid) return [];
            return deriveEvmAddressesFromSeed(input, evmDeriveCount, evmSeedPassphrase || undefined);
        }
        if (det.type === "xpub") {
            return deriveEvmAddressesFromXpub(input, evmDeriveCount);
        }
        return [];
    });
    const evmShowAddressPicker = $derived(evmDerivedAddresses.length > 0);

    // Existing-address sets for duplicate detection (O(1) lookup)
    const existingEvmAddresses = $derived(new Set(ethAccounts.map(a => a.address.toLowerCase())));
    const existingBtcXpubs = $derived(new Set(btcAccounts.map(a => a.address_or_xpub)));

    // Auto-select first unknown index for EVM multi-index picker
    $effect(() => {
        const addrs = evmDerivedAddresses;
        if (addrs.length === 0) return;
        // Only auto-select on first derivation (when selection is default {0})
        if (evmSelectedIndexes.size === 1 && evmSelectedIndexes.has(0)) {
            const firstUnknown = addrs.find(a => !existingEvmAddresses.has(a.address.toLowerCase()));
            if (firstUnknown && firstUnknown.index !== 0) {
                evmSelectedIndexes = new Set([firstUnknown.index]);
            } else if (!firstUnknown) {
                // All known — clear selection
                evmSelectedIndexes = new Set();
            }
        }
    });

    // Single-account duplicate detection
    const evmSingleExists = $derived.by(() => {
        const addr = newAddress.trim();
        if (!addr) return false;
        const det = evmDetection;
        if (det.type !== "address" && det.type !== "private_key") return false;
        let resolved = addr;
        if (det.type === "private_key") {
            try { resolved = deriveEvmAddress(addr); } catch { return false; }
        }
        return existingEvmAddresses.has(resolved.toLowerCase());
    });

    const btcSingleExists = $derived.by(() => {
        const input = btcNewAddressOrXpub.trim();
        if (!input) return false;
        const det = btcDetection;
        if (det.type === "seed" || det.type === "unknown") return false;
        return existingBtcXpubs.has(input);
    });

    const btcBusy = $derived(taskQueue.isActive("btc-sync"));

    // Solana detection and derivation
    const solDetection = $derived.by(() => detectSolInputTypeJs(solNewAddress));
    const existingSolAddresses = $derived(new Set(solAccounts.map(a => a.address)));
    const solSingleExists = $derived.by(() => {
        const addr = solNewAddress.trim();
        if (!addr) return false;
        const det = solDetection;
        if (det.input_type !== "address") return false;
        return existingSolAddresses.has(addr);
    });
    const solBusy = $derived(taskQueue.isActive("sol-sync"));

    // Async derivation of Solana addresses from seed phrase
    $effect(() => {
        const input = solNewAddress.trim();
        const det = solDetection;
        const ack = solPrivateKeyAck;
        const count = solDeriveCount;

        if (!input || det.input_type !== "seed" || !ack) {
            solDerivedAddresses = [];
            return;
        }

        let cancelled = false;
        solDeriving = true;
        try {
            const results = deriveSolAddressesJs(input, count);
            if (!cancelled) {
                solDerivedAddresses = results;
                const firstUnknown = results.find(a => !existingSolAddresses.has(a.address));
                solSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
            }
        } catch {
            if (!cancelled) solDerivedAddresses = [];
        } finally {
            if (!cancelled) solDeriving = false;
        }

        return () => { cancelled = true; };
    });

    // Async derivation of multi-index xpubs from seed phrase
    $effect(() => {
        const input = btcNewAddressOrXpub.trim();
        const det = btcDetection;
        const ack = btcPrivateKeyAck;
        const bip = btcSeedBip;
        const pass = btcSeedPassphrase;
        const count = btcDeriveCount;

        if (!input || det.type !== "seed" || !ack) {
            btcDerivedXpubs = [];
            return;
        }

        let cancelled = false;
        btcDeriving = true;
        deriveMultiXpubsFromSeed(input, bip, count, pass || undefined)
            .then((result) => {
                if (!cancelled) {
                    btcDerivedXpubs = result;
                    // Auto-select first unknown xpub, skip already-added ones
                    const firstUnknown = result.find(x => !existingBtcXpubs.has(x.xpub));
                    btcSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
                }
            })
            .catch(() => {
                if (!cancelled) btcDerivedXpubs = [];
            })
            .finally(() => {
                if (!cancelled) btcDeriving = false;
            });

        return () => { cancelled = true; };
    });

    function startAddBitcoin(prefillInput?: string) {
        addSourceMode = "bitcoin";
        if (prefillInput) btcNewAddressOrXpub = prefillInput;
    }

    async function loadBtcAccounts() {
        try {
            btcAccounts = await getBackend().listBitcoinAccounts();
        } catch (err) {
            toast.error(`Failed to load Bitcoin accounts: ${err}`);
        }
    }

    async function handleAddBtcAccount() {
        let input = btcNewAddressOrXpub.trim();
        const baseLabel = btcNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        btcAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived xpubs
            if (btcDerivedXpubs.length > 0) {
                if (btcSelectedIndexes.size === 0) {
                    toast.error("Select at least one wallet");
                    return;
                }
                const selected = btcDerivedXpubs
                    .filter(x => btcSelectedIndexes.has(x.index))
                    .filter(x => !existingBtcXpubs.has(x.xpub));
                if (selected.length === 0) {
                    toast.error("All selected wallets are already added");
                    return;
                }
                // Clear private material immediately
                btcNewAddressOrXpub = "";
                for (const { index, xpub, keyType } of selected) {
                    const label = btcItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : ellipseAddress(xpub));
                    await getBackend().addBitcoinAccount({
                        id: uuidv7(),
                        address_or_xpub: xpub,
                        account_type: keyType as "xpub" | "ypub" | "zpub",
                        derivation_bip: btcSeedBip,
                        network: "mainnet",
                        label,
                        last_receive_index: -1,
                        last_change_index: -1,
                        created_at: new Date().toISOString(),
                    });
                }
                btcNewLabel = "";
                btcPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadBtcAccounts();
                toast.success(`${selected.length} HD wallet(s) added`);
                return;
            }

            // Single-account path (xpub input, WIF, address, or non-seed private key)
            // Authoritative validation via Rust
            const det = await detectBtcInputType(input);
            if (!det.valid) {
                let msg: string;
                if (det.invalid_words?.length) {
                    msg = `Invalid BIP39 words: ${det.invalid_words.join(", ")}`;
                } else if (det.input_type === "seed" && det.word_count) {
                    const valid = [12, 15, 18, 21, 24];
                    msg = valid.includes(det.word_count)
                        ? `Invalid seed phrase checksum (${det.word_count} words)`
                        : `Invalid word count: ${det.word_count} (must be 12, 15, 18, 21, or 24)`;
                } else {
                    msg = "Invalid Bitcoin input";
                }
                toast.error(msg);
                return;
            }

            let accountType: "address" | "xpub" | "ypub" | "zpub" = "address";
            let derivationBip: number | undefined;
            let network: "mainnet" | "testnet" = det.network === "testnet" ? "testnet" : "mainnet";

            if (det.is_private) {
                // Convert private key → public result, discard private material
                const conv = await convertPrivateKey(
                    input,
                    det.input_type === "seed" ? btcSeedBip : undefined,
                    det.input_type === "seed" ? btcSeedPassphrase : undefined,
                    network,
                );
                // Clear input immediately
                btcNewAddressOrXpub = "";

                if (conv.public_result.kind === "Address") {
                    input = conv.public_result.address;
                    accountType = "address";
                } else {
                    input = conv.public_result.xpub;
                    accountType = conv.public_result.key_type as "xpub" | "ypub" | "zpub";
                    derivationBip = conv.suggested_bip;
                }
                network = conv.network === "testnet" ? "testnet" : "mainnet";

                if (existingBtcXpubs.has(input)) {
                    toast.info("This address is already added");
                    return;
                }
            } else if (det.input_type === "address") {
                accountType = "address";
            } else {
                // Extended public key
                accountType = det.input_type as "xpub" | "ypub" | "zpub";
                derivationBip = det.suggested_bip ?? undefined;
            }

            // Compute label fallback after conversion so it uses the public key, not the private input
            const label = baseLabel || ellipseAddress(input);

            await getBackend().addBitcoinAccount({
                id: uuidv7(),
                address_or_xpub: input,
                account_type: accountType,
                derivation_bip: derivationBip,
                network,
                label,
                last_receive_index: -1,
                last_change_index: -1,
                created_at: new Date().toISOString(),
            });
            btcNewAddressOrXpub = "";
            btcNewLabel = "";
            btcPrivateKeyAck = false;
            addSourceMode = "idle";
            await loadBtcAccounts();
            toast.success("Bitcoin account added");
        } catch (err) {
            toast.error(`Failed to add Bitcoin account: ${err}`);
        } finally {
            btcAddingAccount = false;
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

    // ---- Solana functions ----

    function startAddSolana(prefillAddress?: string) {
        addSourceMode = "solana";
        if (prefillAddress) solNewAddress = prefillAddress;
    }

    async function loadSolAccounts() {
        try {
            solAccounts = await getBackend().listSolanaAccounts();
        } catch (err) {
            toast.error(`Failed to load Solana accounts: ${err}`);
        }
    }

    async function handleAddSolanaAccount() {
        const input = solNewAddress.trim();
        const baseLabel = solNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        solAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (solDerivedAddresses.length > 0) {
                if (solSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = solDerivedAddresses
                    .filter(a => solSelectedIndexes.has(a.index))
                    .filter(a => !existingSolAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                // Clear private material immediately
                solNewAddress = "";
                for (const { index, address } of selected) {
                    const label = solItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : ellipseAddress(address));
                    await getBackend().addSolanaAccount({
                        id: uuidv7(),
                        address,
                        network: "mainnet-beta",
                        label,
                        last_signature: null,
                        created_at: new Date().toISOString(),
                    });
                }
                solNewLabel = "";
                solPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadSolAccounts();
                toast.success(`${selected.length} Solana address(es) added`);
                return;
            }

            // Single address path
            const det = solDetection;
            if (det.input_type === "unknown" || !det.valid) {
                toast.error("Invalid Solana input");
                return;
            }

            if (det.input_type === "keypair") {
                toast.error("Keypair import not yet supported — use the public address instead");
                return;
            }

            if (det.input_type !== "address") {
                toast.error("Please enter a Solana address or seed phrase");
                return;
            }

            if (existingSolAddresses.has(input)) {
                toast.info("This address is already added");
                return;
            }

            const label = baseLabel || ellipseAddress(input);
            await getBackend().addSolanaAccount({
                id: uuidv7(),
                address: input,
                network: "mainnet-beta",
                label,
                last_signature: null,
                created_at: new Date().toISOString(),
            });
            solNewAddress = "";
            solNewLabel = "";
            solPrivateKeyAck = false;
            addSourceMode = "idle";
            await loadSolAccounts();
            toast.success("Solana account added");
        } catch (err) {
            toast.error(`Failed to add Solana account: ${err}`);
        } finally {
            solAddingAccount = false;
        }
    }

    async function handleRemoveSolAccount(id: string) {
        try {
            await getBackend().removeSolanaAccount(id);
            await loadSolAccounts();
            toast.success("Solana account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncSolAccount(account: SolanaAccount) {
        taskQueue.enqueue({
            key: `sol-sync:${account.id}`,
            label: `Sync ${account.label} (Solana)`,
            async run(ctx) {
                const r = await getBackend().syncSolana(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadSolAccounts();
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

    function syncAllSol() {
        for (const account of solAccounts) {
            syncSolAccount(account);
        }
    }

    // -- Hyperliquid functions --

    function startAddHyperliquid(prefillAddress?: string) {
        addSourceMode = "hyperliquid";
        if (prefillAddress) hlNewAddress = prefillAddress;
    }

    async function loadHlAccounts() {
        try {
            hlAccounts = await getBackend().listHyperliquidAccounts();
        } catch (err) {
            toast.error(`Failed to load Hyperliquid accounts: ${err}`);
        }
    }

    async function handleAddHyperliquidAccount() {
        const address = hlNewAddress.trim().toLowerCase();
        const label = hlNewLabel.trim();
        if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
            toast.error("Invalid EVM address");
            return;
        }

        const existing = hlAccounts.find(a => a.address.toLowerCase() === address);
        if (existing) {
            toast.info("This address is already tracked on Hyperliquid");
            return;
        }

        hlAddingAccount = true;
        try {
            await getBackend().addHyperliquidAccount({
                id: uuidv7(),
                address,
                label: label || `${address.slice(0, 6)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            hlNewAddress = "";
            hlNewLabel = "";
            addSourceMode = "idle";
            await loadHlAccounts();
            toast.success("Hyperliquid account added");
        } catch (err) {
            toast.error(`Failed to add Hyperliquid account: ${err}`);
        } finally {
            hlAddingAccount = false;
        }
    }

    async function handleRemoveHlAccount(id: string) {
        try {
            await getBackend().removeHyperliquidAccount(id);
            await loadHlAccounts();
            toast.success("Hyperliquid account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncHlAccount(account: HyperliquidAccount) {
        taskQueue.enqueue({
            key: `hl-sync:${account.id}`,
            label: `Sync ${account.label} (Hyperliquid)`,
            async run(ctx) {
                const r = await getBackend().syncHyperliquid(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadHlAccounts();
                const imported = r.fills_imported + r.funding_imported + r.ledger_imported;
                if (imported > 0) invalidate("journal", "accounts", "reports");
                if (imported > 0) {
                    enqueueRateBackfill(
                        taskQueue,
                        getBackend(),
                        settings.buildRateConfig(),
                        getHiddenCurrencySet(),
                    );
                }
                return {
                    summary: `${r.fills_imported} fills, ${r.funding_imported} funding, ${r.ledger_imported} ledger`,
                    data: r,
                };
            },
        });
    }

    function syncAllHl() {
        for (const account of hlAccounts) {
            syncHlAccount(account);
        }
    }

    const anyBusy = $derived(cexBusy || ethBusy || btcBusy || solBusy || hlBusy);

    async function loadCexAccounts() {
        try {
            cexAccounts = await getBackend().listExchangeAccounts();
        } catch (err) {
            toast.error(`Failed to load exchange accounts: ${err}`);
        }
    }

    function generateCexLabel(exchangeId: ExchangeId): string {
        const name = EXCHANGE_NAMES[exchangeId];
        const existing = cexAccounts
            .filter((a) => a.exchange === exchangeId)
            .map((a) => a.label);
        if (!existing.includes(name)) return name;
        for (let i = 2; ; i++) {
            const candidate = `${name} ${i}`;
            if (!existing.includes(candidate)) return candidate;
        }
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).then(() => {
            toast.success("Copied to clipboard");
        });
    }

    function ellipseAddress(addr: string): string {
        return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    }

    async function addCexAccount() {
        if (!cexNewApiKey || !cexNewApiSecret) {
            toast.error("API Key and API Secret are required");
            return;
        }
        cexAdding = true;
        try {
            const label = cexNewLabel.trim() || generateCexLabel(addSourceExchangeId);
            const account: ExchangeAccount = {
                id: uuidv7(),
                exchange: addSourceExchangeId,
                label,
                api_key: cexNewApiKey,
                api_secret: cexNewApiSecret,
                passphrase: cexNewPassphrase || null,
                opened_at: cexNewOpenedAt || null,
                closed_at: cexNewClosedAt || null,
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
        loadSolAccounts();
        loadHlAccounts();
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
        let addr = newAddress.trim();
        if (!addr) {
            toast.error("Address is required");
            return;
        }

        const detection = detectEvmInputType(addr);
        if (detection.type === "unknown") {
            toast.error("Unrecognized input — enter an 0x address, private key, seed phrase, or xpub");
            return;
        }

        if (selectedChainIds.size === 0) {
            toast.error("Select at least one chain");
            return;
        }

        addingAccount = true;
        try {
            // Multi-index path for seed / xpub
            if (detection.type === "seed" || detection.type === "xpub") {
                if (evmSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                if (detection.type === "seed") {
                    const v = validateEvmSeedPhrase(addr);
                    if (v.invalidWords.length > 0) {
                        toast.error(`Invalid BIP39 words: ${v.invalidWords.join(", ")}`);
                        return;
                    }
                    if (!v.valid) {
                        toast.error("Invalid seed phrase checksum");
                        return;
                    }
                }
                const selected = evmDerivedAddresses
                    .filter(a => evmSelectedIndexes.has(a.index))
                    .filter(a => !existingEvmAddresses.has(a.address.toLowerCase()));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                // Clear private material immediately if seed
                if (detection.type === "seed") newAddress = "";
                const baseLabel = newLabel.trim();
                for (const { index, address } of selected) {
                    const label = evmItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : ellipseAddress(address));
                    for (const chainId of selectedChainIds) {
                        await getBackend().addEtherscanAccount(address, chainId, label);
                    }
                }
                cancelAdd();
                await loadEthAccounts();
                toast.success(`${selected.length} address(es) added to ${selectedChainIds.size} chain(s)`);
            } else {
                // Single-address path for private_key / address
                if (detection.isPrivate) {
                    addr = deriveEvmAddress(addr);
                    newAddress = "";
                }

                if (existingEvmAddresses.has(addr.toLowerCase())) {
                    toast.info("This address is already added");
                    return;
                }

                if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
                    toast.error("Invalid Ethereum address");
                    return;
                }

                const label = newLabel.trim() || ellipseAddress(addr);
                for (const chainId of selectedChainIds) {
                    await getBackend().addEtherscanAccount(addr, chainId, label);
                }
                cancelAdd();
                await loadEthAccounts();
                toast.success(`Address added to ${selectedChainIds.size} chain(s)`);
            }
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
            </Card.Description>
        </Card.Header>
        <Card.Content>
            <div class="flex items-center gap-3">
                <Button onclick={handleImportClick}>
                    <Upload class="mr-2 h-4 w-4" /> {m.sources_import_files()}
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
        </Card.Content>
    </Card.Root>

    <!-- Online Sources -->
    <Card.Root>
        <Card.Header>
            <Card.Title>{m.sources_online()}</Card.Title>
            <Card.Description>{m.sources_online_desc()}</Card.Description>
        </Card.Header>
        <Card.Content class="space-y-6">
            <!-- Smart input / Add forms -->
            {#if addSourceMode === "idle"}
                <AddSourceInput
                    onSelectCex={startAddCex}
                    onSelectBlockchain={startAddBlockchain}
                    onSelectBitcoin={startAddBitcoin}
                    onSelectSolana={startAddSolana}
                    onSelectHyperliquid={startAddHyperliquid}
                    disabled={anyBusy}
                />
            {:else if addSourceMode === "cex"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <Badge variant="secondary">{EXCHANGE_NAMES[addSourceExchangeId]}</Badge>
                            <span class="text-sm font-medium">{m.sources_add_exchange_account()}</span>
                        </div>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <Input
                        class="w-full sm:w-60"
                        placeholder={m.sources_label_optional()}
                        bind:value={cexNewLabel}
                    />
                    <div class="flex flex-wrap gap-2">
                        <Input
                            class="w-full sm:flex-1"
                            type="password"
                            placeholder={addSourceExchangeId === "coinbase"
                                ? m.sources_api_key_name()
                                : addSourceExchangeId === "volet"
                                ? m.sources_api_name()
                                : m.label_api_key()}
                            bind:value={cexNewApiKey}
                        />
                        <Input
                            class="w-full sm:flex-1"
                            type="password"
                            placeholder={addSourceExchangeId === "coinbase"
                                ? m.sources_ec_private_key_pem()
                                : addSourceExchangeId === "volet"
                                ? m.sources_security_word()
                                : m.label_api_secret()}
                            bind:value={cexNewApiSecret}
                        />
                    </div>
                    {#if getCexAdapter(addSourceExchangeId).requiresPassphrase}
                        <Input
                            class="w-full sm:w-64"
                            type="password"
                            placeholder={addSourceExchangeId === "volet" ? m.sources_account_email() : m.label_api_passphrase()}
                            bind:value={cexNewPassphrase}
                        />
                    {/if}
                    <div class="flex flex-wrap gap-2">
                        <div class="space-y-1">
                            <label for="cex-opened-at" class="text-xs font-medium text-muted-foreground">{m.sources_opened_optional()}</label>
                            <Input id="cex-opened-at" class="w-40" type="date" bind:value={cexNewOpenedAt} />
                        </div>
                        <div class="space-y-1">
                            <label for="cex-closed-at" class="text-xs font-medium text-muted-foreground">{m.sources_closed_optional()}</label>
                            <Input id="cex-closed-at" class="w-40" type="date" bind:value={cexNewClosedAt} />
                        </div>
                    </div>
                    <Button size="sm" disabled={cexAdding} onclick={addCexAccount}>
                        <Plus class="mr-1 h-4 w-4" />
                        {m.sources_add_account()}
                    </Button>
                </div>
            {:else if addSourceMode === "blockchain"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">{m.sources_add_evm_address()}</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-eth-address" class="text-xs font-medium">{m.sources_address()}</label>
                            <Input
                                id="new-eth-address"
                                placeholder={m.sources_evm_placeholder()}
                                autocomplete="off"
                                bind:value={newAddress}
                            />
                        </div>
                        <div class="flex-1 space-y-1">
                            <label for="new-eth-label" class="text-xs font-medium">{m.sources_label_optional()}</label>
                            <Input
                                id="new-eth-label"
                                placeholder={m.sources_my_wallet()}
                                bind:value={newLabel}
                            />
                        </div>
                        <Button
                            onclick={handleAddEthAccount}
                            disabled={addingAccount ||
                                !newAddress.trim() ||
                                selectedChainIds.size === 0 ||
                                (evmDetection.isPrivate && !evmPrivateKeyAck) ||
                                (evmShowAddressPicker && evmSelectedIndexes.size === 0) ||
                                evmSingleExists}
                        >
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if evmDetection.type !== "unknown" && newAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if evmDetection.isPrivate}
                                <Badge variant="outline" class="border-amber-500 text-amber-600">{evmDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-600">{evmDetection.description}</Badge>
                            {/if}
                            {#if evmSingleExists}
                                <span class="text-xs text-amber-600 dark:text-amber-400">{m.sources_address_already_added()}</span>
                            {/if}
                        </div>
                    {/if}
                    {#if evmDetection.isPrivate}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">
                                {m.sources_evm_private_key_warning()}
                            </p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={evmPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                        {#if evmDetection.type === "seed"}
                            <div class="flex-1 space-y-1">
                                <label for="evm-seed-pass" class="text-xs font-medium">{m.sources_passphrase_optional()}</label>
                                <Input id="evm-seed-pass" type="password" placeholder={m.sources_usually_empty()} autocomplete="off" bind:value={evmSeedPassphrase} />
                            </div>
                        {/if}
                    {/if}

                    <!-- Multi-index address picker -->
                    {#if evmShowAddressPicker}
                        <div class="space-y-2">
                            <span class="text-xs font-medium">{m.sources_derived_addresses()}</span>
                            <div class="max-h-48 overflow-y-auto rounded-md border">
                                {#each evmDerivedAddresses as { index, address }}
                                    {@const exists = existingEvmAddresses.has(address.toLowerCase())}
                                    <label class="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 cursor-pointer"
                                           class:opacity-50={exists} class:cursor-not-allowed={exists}>
                                        <input
                                            type="checkbox"
                                            checked={evmSelectedIndexes.has(index)}
                                            disabled={exists}
                                            onchange={() => {
                                                const next = new Set(evmSelectedIndexes);
                                                if (next.has(index)) next.delete(index); else next.add(index);
                                                evmSelectedIndexes = next;
                                            }}
                                        />
                                        <Tooltip.Root>
                                            <Tooltip.Trigger class="font-mono text-xs truncate">{address}</Tooltip.Trigger>
                                            <Tooltip.Content><p class="font-mono text-xs">{address}</p></Tooltip.Content>
                                        </Tooltip.Root>
                                        <button onclick={(e) => { e.preventDefault(); e.stopPropagation(); copyToClipboard(address); }} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                            <Copy class="h-3 w-3" />
                                        </button>
                                        <span class="text-xs text-muted-foreground">#{index}</span>
                                        {#if exists}
                                            <span class="ml-auto text-xs text-muted-foreground italic">{m.sources_already_added()}</span>
                                        {:else}
                                            <input
                                                type="text"
                                                class="ml-auto h-6 w-28 rounded border bg-background px-1.5 text-xs"
                                                placeholder={m.label_label()}
                                                value={evmItemLabels.get(index) ?? ""}
                                                oninput={(e) => {
                                                    const next = new Map(evmItemLabels);
                                                    next.set(index, e.currentTarget.value);
                                                    evmItemLabels = next;
                                                }}
                                                onclick={(e) => e.stopPropagation()}
                                            />
                                        {/if}
                                    </label>
                                {/each}
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: evmSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { evmDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}

                    <!-- Chain selector -->
                    <div class="space-y-2">
                        <span class="text-xs font-medium">{m.sources_chains()}</span>
                        <Popover.Root bind:open={chainPopoverOpen}>
                            <Popover.Trigger>
                                <Button
                                    variant="outline"
                                    class="w-[300px] justify-between"
                                >
                                    {#if selectedChainIds.size === 0}
                                        {m.sources_select_chains()}
                                    {:else}
                                        {m.sources_chains_selected({ count: selectedChainIds.size })}
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
            {:else if addSourceMode === "bitcoin"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">{m.sources_add_bitcoin()}</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-btc-input" class="text-xs font-medium">{m.sources_address_or_xpub()}</label>
                            <Input
                                id="new-btc-input"
                                placeholder={m.sources_paste_btc_placeholder()}
                                autocomplete="off"
                                bind:value={btcNewAddressOrXpub}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-btc-label" class="text-xs font-medium">{m.sources_label_optional()}</label>
                            <Input
                                id="new-btc-label"
                                placeholder={m.sources_my_btc_wallet()}
                                bind:value={btcNewLabel}
                            />
                        </div>
                        <Button
                            onclick={handleAddBtcAccount}
                            disabled={btcAddingAccount || !btcNewAddressOrXpub.trim() || (btcDetection.isPrivate && !btcPrivateKeyAck) || (btcDerivedXpubs.length > 0 && btcSelectedIndexes.size === 0) || btcSingleExists}
                        >
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>
                    {#if btcDetection.type !== "unknown" && btcNewAddressOrXpub.trim()}
                        <div class="flex items-center gap-2">
                            {#if btcDetection.isPrivate}
                                <Badge variant="outline" class="border-amber-500 text-amber-600">{btcDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-600">{btcDetection.description}</Badge>
                            {/if}
                            {#if btcSingleExists}
                                <span class="text-xs text-amber-600 dark:text-amber-400">{m.sources_address_already_added()}</span>
                            {/if}
                        </div>
                    {/if}
                    {#if btcDetection.isPrivate}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">
                                {m.sources_btc_private_key_warning()}
                            </p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={btcPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_pubkey()}</span>
                            </label>
                        </div>
                        {#if btcDetection.type === "seed"}
                            <div class="flex items-end gap-4">
                                <div class="space-y-1">
                                    <label for="btc-seed-bip" class="text-xs font-medium">{m.sources_bip_standard()}</label>
                                    <select id="btc-seed-bip" bind:value={btcSeedBip} class="h-9 rounded-md border bg-background px-3 text-sm">
                                        <option value={84}>{m.sources_bip84()}</option>
                                        <option value={49}>{m.sources_bip49()}</option>
                                        <option value={44}>{m.sources_bip44()}</option>
                                    </select>
                                </div>
                                <div class="flex-1 space-y-1">
                                    <label for="btc-seed-pass" class="text-xs font-medium">{m.sources_passphrase_optional()}</label>
                                    <Input id="btc-seed-pass" type="password" placeholder={m.sources_usually_empty()} autocomplete="off" bind:value={btcSeedPassphrase} />
                                </div>
                            </div>
                        {/if}
                    {/if}

                    <!-- Multi-index xpub picker -->
                    {#if btcDerivedXpubs.length > 0}
                        <div class="space-y-2">
                            <span class="text-xs font-medium">{m.sources_derived_hd_wallets()}</span>
                            {#if btcDeriving}
                                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                                    <RefreshCw class="h-3 w-3 animate-spin" />
                                    {m.sources_deriving()}
                                </div>
                            {/if}
                            <div class="max-h-48 overflow-y-auto rounded-md border">
                                {#each btcDerivedXpubs as { index, xpub, keyType }}
                                    {@const exists = existingBtcXpubs.has(xpub)}
                                    <label class="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 cursor-pointer"
                                           class:opacity-50={exists} class:cursor-not-allowed={exists}>
                                        <input
                                            type="checkbox"
                                            checked={btcSelectedIndexes.has(index)}
                                            disabled={exists}
                                            onchange={() => {
                                                const next = new Set(btcSelectedIndexes);
                                                if (next.has(index)) next.delete(index); else next.add(index);
                                                btcSelectedIndexes = next;
                                            }}
                                        />
                                        <Tooltip.Root>
                                            <Tooltip.Trigger class="font-mono text-xs truncate">{xpub.slice(0, 16)}...{xpub.slice(-8)}</Tooltip.Trigger>
                                            <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{xpub}</p></Tooltip.Content>
                                        </Tooltip.Root>
                                        <button onclick={(e) => { e.preventDefault(); e.stopPropagation(); copyToClipboard(xpub); }} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                            <Copy class="h-3 w-3" />
                                        </button>
                                        <span class="text-xs text-muted-foreground">#{index}</span>
                                        <Badge variant="secondary" class="text-[10px] px-1 py-0">{keyType}</Badge>
                                        {#if exists}
                                            <span class="ml-auto text-xs text-muted-foreground italic">{m.sources_already_added()}</span>
                                        {:else}
                                            <input
                                                type="text"
                                                class="ml-auto h-6 w-28 rounded border bg-background px-1.5 text-xs"
                                                placeholder={m.label_label()}
                                                value={btcItemLabels.get(index) ?? ""}
                                                oninput={(e) => {
                                                    const next = new Map(btcItemLabels);
                                                    next.set(index, e.currentTarget.value);
                                                    btcItemLabels = next;
                                                }}
                                                onclick={(e) => e.stopPropagation()}
                                            />
                                        {/if}
                                    </label>
                                {/each}
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_wallets_selected({ count: btcSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { btcDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "solana"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">{m.sources_add_solana()}</span>
                        <Button variant="ghost" size="sm" onclick={() => { addSourceMode = "idle"; solNewAddress = ""; solNewLabel = ""; solPrivateKeyAck = false; }}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-sol-address" class="text-xs font-medium">{m.sources_address_or_seed()}</label>
                            <Input
                                id="new-sol-address"
                                placeholder={m.sources_paste_sol_placeholder()}
                                autocomplete="off"
                                bind:value={solNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-sol-label" class="text-xs font-medium">{m.sources_label_optional()}</label>
                            <Input id="new-sol-label" placeholder={m.sources_my_sol_wallet()} bind:value={solNewLabel} />
                        </div>
                        <Button onclick={handleAddSolanaAccount} disabled={solAddingAccount || (!solNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if solDetection.input_type !== "unknown" && solNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if solDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{solDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{solDetection.description}</Badge>
                            {/if}
                            {#if solSingleExists}
                                <span class="text-xs text-muted-foreground">{m.sources_already_added()}</span>
                            {/if}
                        </div>
                    {/if}

                    {#if solDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={solPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if solDeriving}
                        <div class="text-xs text-muted-foreground">{m.sources_deriving_addresses()}</div>
                    {/if}

                    {#if solDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each solDerivedAddresses as derived}
                                {@const exists = existingSolAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={solSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(solSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            solSelectedIndexes = next;
                                        }}
                                    />
                                    <span class="font-mono">{derived.index}</span>
                                    <span class="font-mono truncate flex-1">{derived.address}</span>
                                    <Button variant="ghost" size="sm" class="h-5 w-5 p-0" onclick={() => copyToClipboard(derived.address)}>
                                        <Copy class="h-3 w-3" />
                                    </Button>
                                    <Input
                                        class="h-6 w-24 text-xs"
                                        placeholder={m.label_label()}
                                        value={solItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(solItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); solItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: solSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { solDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "hyperliquid"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Hyperliquid Account</span>
                        <Button variant="ghost" size="sm" onclick={() => { addSourceMode = "idle"; hlNewAddress = ""; hlNewLabel = ""; }}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Hyperliquid uses your EVM address. No API key needed — all data is public.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-hl-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-hl-address"
                                placeholder="0x..."
                                autocomplete="off"
                                bind:value={hlNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-hl-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-hl-label" placeholder="My Hyperliquid" bind:value={hlNewLabel} />
                        </div>
                        <Button onclick={handleAddHyperliquidAccount} disabled={hlAddingAccount || (!hlNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>
                </div>
            {/if}

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
                        <Table.Header>
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
                                    <Table.Row>
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
                                            <Badge variant="secondary">{m.sources_bitcoin()}</Badge>
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
                                {:else if row.kind === "sol"}
                                    {@const solAccount = row.data}
                                    {@const isSolSyncing = taskQueue.isActive(`sol-sync:${solAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {solAccount.address.length > 20
                                                            ? `${solAccount.address.slice(0, 12)}...${solAccount.address.slice(-8)}`
                                                            : solAccount.address}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{solAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(solAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === solAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("sol"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {solAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">{m.sources_solana_address()}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">{m.sources_solana()}</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {solAccount.last_sync
                                                ? new Date(solAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncSolAccount(solAccount)}
                                                    disabled={solBusy || editingRowId === solAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isSolSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === solAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === solAccount.id ? (editingRowId = null) : startEditLabel(solAccount.id, solAccount.label)} disabled={solBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveSolAccount(solAccount.id)}
                                                    disabled={solBusy || editingRowId === solAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "hl"}
                                    {@const hlAccount = row.data}
                                    {@const isHlSyncing = taskQueue.isActive(`hl-sync:${hlAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {hlAccount.address.slice(0, 6)}...{hlAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{hlAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(hlAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === hlAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("hl"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {hlAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Hyperliquid</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Hyperliquid</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {hlAccount.last_sync
                                                ? new Date(hlAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncHlAccount(hlAccount)}
                                                    disabled={hlBusy || editingRowId === hlAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isHlSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === hlAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === hlAccount.id ? (editingRowId = null) : startEditLabel(hlAccount.id, hlAccount.label)} disabled={hlBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveHlAccount(hlAccount.id)}
                                                    disabled={hlBusy || editingRowId === hlAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
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
                                        <Table.Row>
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
                                                <Badge variant="secondary">{m.sources_evm()}</Badge>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <div class="flex flex-wrap gap-1">
                                                    {#each group.chainIds as chainId}
                                                        <Badge variant="secondary">{getChainName(chainId)}</Badge>
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
                        <Table.Header>
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
                                <Table.Row>
                                    <Table.Cell>
                                        <Badge variant="secondary">{account.exchange}</Badge>
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
                                        {@const isCexSyncing = taskQueue.queue.some((t) => t.key === `cex-sync:${account.id}` && t.status === "running")}
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
            {#if cexAccounts.length === 0 && blockchainRows.length === 0 && addSourceMode === "idle"}
                <p class="text-sm text-muted-foreground">{m.empty_no_online_sources()}</p>
            {/if}
        </Card.Content>

        <!-- Footer with unified actions -->
        {#if cexAccounts.length > 0 || ethAccounts.length > 0 || btcAccounts.length > 0}
            <Card.Footer class="flex justify-end gap-2">
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
