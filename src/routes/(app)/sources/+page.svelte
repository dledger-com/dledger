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
    import type { SuiAccount } from "$lib/sui/types.js";
    import type { AptosAccount } from "$lib/aptos/types.js";
    import type { TonAccount } from "$lib/ton/types.js";
    import type { TezosAccount } from "$lib/tezos/types.js";
    import type { CosmosAccount } from "$lib/cosmos/types.js";
    import type { PolkadotAccount } from "$lib/polkadot/types.js";
    import type { BtcForkAccount, BtcForkChainConfig } from "$lib/btc-fork/types.js";
    import { BTC_FORK_CHAINS } from "$lib/btc-fork/types.js";
    import { detectBtcForkInputType, deriveBtcForkAddresses } from "$lib/btc-fork/derive-js.js";
    import type { BtcForkInputDetection, DerivedBtcForkAddress } from "$lib/btc-fork/types.js";
    import type { XrpAccount } from "$lib/xrp/types.js";
    import { detectXrpInputType, deriveXrpAddresses } from "$lib/xrp/derive-js.js";
    import type { DerivedXrpAddress } from "$lib/xrp/derive-js.js";
    import type { TronAccount } from "$lib/tron/types.js";
    import { detectTronInputType, deriveTronAddresses } from "$lib/tron/derive-js.js";
    import type { DerivedTronAddress } from "$lib/tron/derive-js.js";
    import type { StellarAccount } from "$lib/stellar/types.js";
    import { detectStellarInputType, deriveStellarAddresses } from "$lib/stellar/derive-js.js";
    import type { DerivedStellarAddress } from "$lib/stellar/derive-js.js";
    import type { BittensorAccount } from "$lib/bittensor/types.js";
    import { detectBittensorInputType, deriveBittensorAddresses } from "$lib/bittensor/derive-js.js";
    import type { DerivedBittensorAddress } from "$lib/bittensor/derive-js.js";
    import type { HederaAccount } from "$lib/hedera/types.js";
    import { detectHederaInputType, deriveHederaAddresses } from "$lib/hedera/derive-js.js";
    import type { DerivedHederaAddress } from "$lib/hedera/derive-js.js";
    import type { NearAccount } from "$lib/near/types.js";
    import { detectNearInputType, deriveNearAddresses } from "$lib/near/derive-js.js";
    import type { DerivedNearAddress } from "$lib/near/derive-js.js";
    import type { AlgorandAccount } from "$lib/algorand/types.js";
    import { detectAlgorandInputType, deriveAlgorandAddresses } from "$lib/algorand/derive-js.js";
    import type { DerivedAlgorandAddress } from "$lib/algorand/derive-js.js";
    import type { KaspaAccount } from "$lib/kaspa/types.js";
    import { detectKaspaInputType, deriveKaspaAddresses } from "$lib/kaspa/derive-js.js";
    import type { DerivedKaspaAddress } from "$lib/kaspa/derive-js.js";
    import type { ZcashAccount } from "$lib/zcash/types.js";
    import { detectZcashInputType, deriveZcashAddresses } from "$lib/zcash/derive-js.js";
    import type { DerivedZcashAddress } from "$lib/zcash/derive-js.js";
    import type { StacksAccount } from "$lib/stacks/types.js";
    import { detectStacksInputType, deriveStacksAddresses } from "$lib/stacks/derive-js.js";
    import type { DerivedStacksAddress } from "$lib/stacks/derive-js.js";
    import type { DerivedSolAddress } from "$lib/solana/derive-js.js";
    import { detectSuiInputType, deriveSuiAddresses } from "$lib/sui/derive-js.js";
    import type { DerivedSuiAddress } from "$lib/sui/derive-js.js";
    import { detectAptosInputType, deriveAptosAddresses } from "$lib/aptos/derive-js.js";
    import type { DerivedAptosAddress } from "$lib/aptos/derive-js.js";
    import { detectTonInputType, deriveTonAddresses } from "$lib/ton/derive-js.js";
    import type { DerivedTonAddress } from "$lib/ton/derive-js.js";
    import { detectTezosInputType, deriveTezosAddresses } from "$lib/tezos/derive-js.js";
    import type { DerivedTezosAddress } from "$lib/tezos/derive-js.js";
    import { detectCosmosInputType, deriveCosmosAddresses } from "$lib/cosmos/derive-js.js";
    import type { DerivedCosmosAddress } from "$lib/cosmos/derive-js.js";
    import { detectPolkadotInputType, derivePolkadotAddresses } from "$lib/polkadot/derive-js.js";
    import type { DerivedPolkadotAddress } from "$lib/polkadot/derive-js.js";
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

    async function saveEditLabel(kind: "btc" | "sol" | "hl" | "sui" | "aptos" | "ton" | "tezos" | "cosmos" | "polkadot" | "doge" | "ltc" | "bch" | "xrp" | "tron" | "stellar" | "bittensor" | "hedera" | "near" | "algorand" | "kaspa" | "zcash" | "stacks" | "cex") {
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
            } else if (kind === "sui") {
                await getBackend().updateSuiAccountLabel(editingRowId, label);
                await loadSuiAccounts();
            } else if (kind === "aptos") {
                await getBackend().updateAptosAccountLabel(editingRowId, label);
                await loadAptosAccounts();
            } else if (kind === "ton") {
                await getBackend().updateTonAccountLabel(editingRowId, label);
                await loadTonAccounts();
            } else if (kind === "tezos") {
                await getBackend().updateTezosAccountLabel(editingRowId, label);
                await loadTezosAccounts();
            } else if (kind === "cosmos") {
                await getBackend().updateCosmosAccountLabel(editingRowId, label);
                await loadCosmosAccounts();
            } else if (kind === "polkadot") {
                await getBackend().updatePolkadotAccountLabel(editingRowId, label);
                await loadPolkadotAccounts();
            } else if (kind === "doge") {
                await getBackend().updateDogeAccountLabel(editingRowId, label);
                await loadDogeAccounts();
            } else if (kind === "ltc") {
                await getBackend().updateLtcAccountLabel(editingRowId, label);
                await loadLtcAccounts();
            } else if (kind === "bch") {
                await getBackend().updateBchAccountLabel(editingRowId, label);
                await loadBchAccounts();
            } else if (kind === "xrp") {
                await getBackend().updateXrpAccountLabel(editingRowId, label);
                await loadXrpAccounts();
            } else if (kind === "tron") {
                await getBackend().updateTronAccountLabel(editingRowId, label);
                await loadTronAccounts();
            } else if (kind === "stellar") {
                await getBackend().updateStellarAccountLabel(editingRowId, label);
                await loadStellarAccounts();
            } else if (kind === "bittensor") {
                await getBackend().updateBittensorAccountLabel(editingRowId, label);
                await loadBittensorAccounts();
            } else if (kind === "hedera") {
                await getBackend().updateHederaAccountLabel(editingRowId, label);
                await loadHederaAccounts();
            } else if (kind === "near") {
                await getBackend().updateNearAccountLabel(editingRowId, label);
                await loadNearAccounts();
            } else if (kind === "algorand") {
                await getBackend().updateAlgorandAccountLabel(editingRowId, label);
                await loadAlgorandAccounts();
            } else if (kind === "kaspa") {
                await getBackend().updateKaspaAccountLabel(editingRowId, label);
                await loadKaspaAccounts();
            } else if (kind === "zcash") {
                await getBackend().updateZcashAccountLabel(editingRowId, label);
                await loadZcashAccounts();
            } else if (kind === "stacks") {
                await getBackend().updateStacksAccountLabel(editingRowId, label);
                await loadStacksAccounts();
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
        | { kind: "hl"; data: HyperliquidAccount }
        | { kind: "sui"; data: SuiAccount }
        | { kind: "aptos"; data: AptosAccount }
        | { kind: "ton"; data: TonAccount }
        | { kind: "tezos"; data: TezosAccount }
        | { kind: "cosmos"; data: CosmosAccount }
        | { kind: "polkadot"; data: PolkadotAccount }
        | { kind: "doge"; data: BtcForkAccount }
        | { kind: "ltc"; data: BtcForkAccount }
        | { kind: "bch"; data: BtcForkAccount }
        | { kind: "xrp"; data: XrpAccount }
        | { kind: "tron"; data: TronAccount }
        | { kind: "stellar"; data: StellarAccount }
        | { kind: "bittensor"; data: BittensorAccount }
        | { kind: "hedera"; data: HederaAccount }
        | { kind: "near"; data: NearAccount }
        | { kind: "algorand"; data: AlgorandAccount }
        | { kind: "kaspa"; data: KaspaAccount }
        | { kind: "zcash"; data: ZcashAccount }
        | { kind: "stacks"; data: StacksAccount };

    const blockchainRows = $derived.by((): BlockchainRow[] => {
        const rows: BlockchainRow[] = [];
        for (const account of btcAccounts) rows.push({ kind: "btc", data: account });
        for (const group of groupedAddresses) rows.push({ kind: "evm", data: group });
        for (const account of solAccounts) rows.push({ kind: "sol", data: account });
        for (const account of hlAccounts) rows.push({ kind: "hl", data: account });
        for (const account of suiAccounts) rows.push({ kind: "sui", data: account });
        for (const account of aptosAccounts) rows.push({ kind: "aptos", data: account });
        for (const account of tonAccounts) rows.push({ kind: "ton", data: account });
        for (const account of tezosAccounts) rows.push({ kind: "tezos", data: account });
        for (const account of cosmosAccounts) rows.push({ kind: "cosmos", data: account });
        for (const account of polkadotAccounts) rows.push({ kind: "polkadot", data: account });
        for (const account of dogeAccounts) rows.push({ kind: "doge", data: account });
        for (const account of ltcAccounts) rows.push({ kind: "ltc", data: account });
        for (const account of bchAccounts) rows.push({ kind: "bch", data: account });
        for (const account of xrpAccounts) rows.push({ kind: "xrp", data: account });
        for (const account of tronAccounts) rows.push({ kind: "tron", data: account });
        for (const account of stellarAccounts) rows.push({ kind: "stellar", data: account });
        for (const account of bittensorAccounts) rows.push({ kind: "bittensor", data: account });
        for (const account of hederaAccounts) rows.push({ kind: "hedera", data: account });
        for (const account of nearAccounts) rows.push({ kind: "near", data: account });
        for (const account of algorandAccounts) rows.push({ kind: "algorand", data: account });
        for (const account of kaspaAccounts) rows.push({ kind: "kaspa", data: account });
        for (const account of zcashAccounts) rows.push({ kind: "zcash", data: account });
        for (const account of stacksAccounts) rows.push({ kind: "stacks", data: account });
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
        btc: "BTC", sol: "Solana", hl: "Hyperliquid", sui: "Sui", aptos: "Aptos",
        ton: "TON", tezos: "Tezos", cosmos: "Cosmos", polkadot: "Polkadot",
        doge: "Dogecoin", ltc: "Litecoin", bch: "Bitcoin Cash", xrp: "XRP",
        tron: "TRON", stellar: "Stellar", bittensor: "Bittensor", hedera: "Hedera",
        near: "NEAR", algorand: "Algorand", kaspa: "Kaspa", zcash: "Zcash", stacks: "Stacks",
        evm: "EVM",
    };
    const blockchainAccessors: Record<BlockchainSortKey, SortAccessor<BlockchainRow>> = {
        address: (r) => getBlockchainRowAddress(r),
        label: (r) => r.data.label,
        type: (r) => r.kind === "btc"
            ? (r.data.account_type === "address" ? "BTC Address" : "HD Wallet")
            : CHAIN_TYPE_LABELS[r.kind] ?? "EVM",
        networks: (r) => r.kind === "btc"
            ? "Bitcoin"
            : r.kind === "evm" ? r.data.chainIds.map((id) => getChainName(id)).join(", ")
            : CHAIN_TYPE_LABELS[r.kind] ?? r.kind,
        lastSync: (r) => r.kind === "evm" ? "" : (r.data.last_sync || ""),
    };

    function isAccountClosed(account: ExchangeAccount): boolean {
        if (!account.closed_at) return false;
        return account.closed_at < new Date().toISOString().slice(0, 10);
    }

    type AddSourceMode = "idle" | "cex" | "blockchain" | "bitcoin" | "solana" | "hyperliquid" | "sui" | "aptos" | "ton" | "tezos" | "cosmos" | "polkadot" | "doge" | "ltc" | "bch" | "xrp" | "tron" | "stellar" | "bittensor" | "hedera" | "near" | "algorand" | "kaspa" | "zcash" | "stacks";
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
        hlNewAddress = "";
        hlNewLabel = "";
        hlPrivateKeyAck = false;
        hlDeriveCount = 5;
        hlSelectedIndexes = new Set([0]);
        hlItemLabels = new Map();
        hlDerivedAddresses = [];
        suiNewAddress = "";
        suiNewLabel = "";
        suiPrivateKeyAck = false;
        suiDeriveCount = 5;
        suiSelectedIndexes = new Set([0]);
        suiItemLabels = new Map();
        suiDerivedAddresses = [];
        aptosNewAddress = "";
        aptosNewLabel = "";
        aptosPrivateKeyAck = false;
        aptosDeriveCount = 5;
        aptosSelectedIndexes = new Set([0]);
        aptosItemLabels = new Map();
        aptosDerivedAddresses = [];
        tonNewAddress = "";
        tonNewLabel = "";
        tonPrivateKeyAck = false;
        tonDeriveCount = 5;
        tonSelectedIndexes = new Set([0]);
        tonItemLabels = new Map();
        tonDerivedAddresses = [];
        tezosNewAddress = "";
        tezosNewLabel = "";
        tezosPrivateKeyAck = false;
        tezosDeriveCount = 5;
        tezosSelectedIndexes = new Set([0]);
        tezosItemLabels = new Map();
        tezosDerivedAddresses = [];
        cosmosNewAddress = "";
        cosmosNewLabel = "";
        cosmosPrivateKeyAck = false;
        cosmosDeriveCount = 5;
        cosmosSelectedIndexes = new Set([0]);
        cosmosItemLabels = new Map();
        cosmosDerivedAddresses = [];
        polkadotNewAddress = "";
        polkadotNewLabel = "";
        polkadotPrivateKeyAck = false;
        polkadotDeriveCount = 5;
        polkadotSelectedIndexes = new Set([0]);
        polkadotItemLabels = new Map();
        polkadotDerivedAddresses = [];
        dogeNewAddress = "";
        dogeNewLabel = "";
        dogePrivateKeyAck = false;
        dogeDeriveCount = 5;
        dogeSelectedIndexes = new Set([0]);
        dogeItemLabels = new Map();
        dogeDerivedAddresses = [];
        ltcNewAddress = "";
        ltcNewLabel = "";
        ltcPrivateKeyAck = false;
        ltcDeriveCount = 5;
        ltcSelectedIndexes = new Set([0]);
        ltcItemLabels = new Map();
        ltcDerivedAddresses = [];
        bchNewAddress = "";
        bchNewLabel = "";
        xrpNewAddress = "";
        xrpNewLabel = "";
        xrpPrivateKeyAck = false;
        xrpDeriveCount = 5;
        xrpSelectedIndexes = new Set([0]);
        xrpItemLabels = new Map();
        xrpDerivedAddresses = [];
        tronNewAddress = "";
        tronNewLabel = "";
        tronPrivateKeyAck = false;
        tronDeriveCount = 5;
        tronSelectedIndexes = new Set([0]);
        tronItemLabels = new Map();
        tronDerivedAddresses = [];
        stellarNewAddress = "";
        stellarNewLabel = "";
        stellarPrivateKeyAck = false;
        stellarDeriveCount = 5;
        stellarSelectedIndexes = new Set([0]);
        stellarItemLabels = new Map();
        stellarDerivedAddresses = [];
        bittensorNewAddress = "";
        bittensorNewLabel = "";
        bittensorPrivateKeyAck = false;
        bittensorDeriveCount = 5;
        bittensorSelectedIndexes = new Set([0]);
        bittensorItemLabels = new Map();
        bittensorDerivedAddresses = [];
        hederaNewAddress = "";
        hederaNewLabel = "";
        hederaPrivateKeyAck = false;
        hederaDeriveCount = 5;
        hederaSelectedIndexes = new Set([0]);
        hederaItemLabels = new Map();
        hederaDerivedAddresses = [];
        nearNewAddress = "";
        nearNewLabel = "";
        nearPrivateKeyAck = false;
        nearDeriveCount = 5;
        nearSelectedIndexes = new Set([0]);
        nearItemLabels = new Map();
        nearDerivedAddresses = [];
        algorandNewAddress = "";
        algorandNewLabel = "";
        algorandPrivateKeyAck = false;
        algorandDeriveCount = 5;
        algorandSelectedIndexes = new Set([0]);
        algorandItemLabels = new Map();
        algorandDerivedAddresses = [];
        kaspaNewAddress = "";
        kaspaNewLabel = "";
        kaspaPrivateKeyAck = false;
        kaspaDeriveCount = 5;
        kaspaSelectedIndexes = new Set([0]);
        kaspaItemLabels = new Map();
        kaspaDerivedAddresses = [];
        zcashNewAddress = "";
        zcashNewLabel = "";
        zcashPrivateKeyAck = false;
        zcashDeriveCount = 5;
        zcashSelectedIndexes = new Set([0]);
        zcashItemLabels = new Map();
        zcashDerivedAddresses = [];
        stacksNewAddress = "";
        stacksNewLabel = "";
        stacksPrivateKeyAck = false;
        stacksDeriveCount = 5;
        stacksSelectedIndexes = new Set([0]);
        stacksItemLabels = new Map();
        stacksDerivedAddresses = [];
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
    let hlPrivateKeyAck = $state(false);
    let hlDeriveCount = $state(5);
    let hlSelectedIndexes = $state<Set<number>>(new Set([0]));
    let hlItemLabels = $state<Map<number, string>>(new Map());
    let hlDerivedAddresses = $state<{index: number; address: string}[]>([]);

    // Sui state
    let suiAccounts = $state<SuiAccount[]>([]);
    let suiNewAddress = $state("");
    let suiNewLabel = $state("");
    let suiAddingAccount = $state(false);
    const suiBusy = $derived(taskQueue.isActive("sui-sync"));
    let suiPrivateKeyAck = $state(false);
    let suiDeriveCount = $state(5);
    let suiSelectedIndexes = $state<Set<number>>(new Set([0]));
    let suiItemLabels = $state<Map<number, string>>(new Map());
    let suiDerivedAddresses = $state<DerivedSuiAddress[]>([]);

    // Aptos state
    let aptosAccounts = $state<AptosAccount[]>([]);
    let aptosNewAddress = $state("");
    let aptosNewLabel = $state("");
    let aptosAddingAccount = $state(false);
    const aptosBusy = $derived(taskQueue.isActive("aptos-sync"));
    let aptosPrivateKeyAck = $state(false);
    let aptosDeriveCount = $state(5);
    let aptosSelectedIndexes = $state<Set<number>>(new Set([0]));
    let aptosItemLabels = $state<Map<number, string>>(new Map());
    let aptosDerivedAddresses = $state<DerivedAptosAddress[]>([]);

    // TON state
    let tonAccounts = $state<TonAccount[]>([]);
    let tonNewAddress = $state("");
    let tonNewLabel = $state("");
    let tonAddingAccount = $state(false);
    const tonBusy = $derived(taskQueue.isActive("ton-sync"));
    let tonPrivateKeyAck = $state(false);
    let tonDeriveCount = $state(5);
    let tonSelectedIndexes = $state<Set<number>>(new Set([0]));
    let tonItemLabels = $state<Map<number, string>>(new Map());
    let tonDerivedAddresses = $state<DerivedTonAddress[]>([]);

    // Tezos state
    let tezosAccounts = $state<TezosAccount[]>([]);
    let tezosNewAddress = $state("");
    let tezosNewLabel = $state("");
    let tezosAddingAccount = $state(false);
    const tezosBusy = $derived(taskQueue.isActive("tezos-sync"));
    let tezosPrivateKeyAck = $state(false);
    let tezosDeriveCount = $state(5);
    let tezosSelectedIndexes = $state<Set<number>>(new Set([0]));
    let tezosItemLabels = $state<Map<number, string>>(new Map());
    let tezosDerivedAddresses = $state<DerivedTezosAddress[]>([]);

    // Cosmos state
    let cosmosAccounts = $state<CosmosAccount[]>([]);
    let cosmosNewAddress = $state("");
    let cosmosNewLabel = $state("");
    let cosmosAddingAccount = $state(false);
    const cosmosBusy = $derived(taskQueue.isActive("cosmos-sync"));
    let cosmosPrivateKeyAck = $state(false);
    let cosmosDeriveCount = $state(5);
    let cosmosSelectedIndexes = $state<Set<number>>(new Set([0]));
    let cosmosItemLabels = $state<Map<number, string>>(new Map());
    let cosmosDerivedAddresses = $state<DerivedCosmosAddress[]>([]);

    // Polkadot state
    let polkadotAccounts = $state<PolkadotAccount[]>([]);
    let polkadotNewAddress = $state("");
    let polkadotNewLabel = $state("");
    let polkadotAddingAccount = $state(false);
    const polkadotBusy = $derived(taskQueue.isActive("polkadot-sync"));
    let polkadotPrivateKeyAck = $state(false);
    let polkadotDeriveCount = $state(5);
    let polkadotSelectedIndexes = $state<Set<number>>(new Set([0]));
    let polkadotItemLabels = $state<Map<number, string>>(new Map());
    let polkadotDerivedAddresses = $state<DerivedPolkadotAddress[]>([]);

    // Dogecoin state (BTC fork)
    let dogeAccounts = $state<BtcForkAccount[]>([]);
    let dogeNewAddress = $state("");
    let dogeNewLabel = $state("");
    let dogeAddingAccount = $state(false);
    const dogeBusy = $derived(taskQueue.isActive("doge-sync"));
    let dogePrivateKeyAck = $state(false);
    let dogeDeriveCount = $state(5);
    let dogeSelectedIndexes = $state<Set<number>>(new Set([0]));
    let dogeItemLabels = $state<Map<number, string>>(new Map());
    let dogeDerivedAddresses = $state<DerivedBtcForkAddress[]>([]);

    // Litecoin state (BTC fork)
    let ltcAccounts = $state<BtcForkAccount[]>([]);
    let ltcNewAddress = $state("");
    let ltcNewLabel = $state("");
    let ltcAddingAccount = $state(false);
    const ltcBusy = $derived(taskQueue.isActive("ltc-sync"));
    let ltcPrivateKeyAck = $state(false);
    let ltcDeriveCount = $state(5);
    let ltcSelectedIndexes = $state<Set<number>>(new Set([0]));
    let ltcItemLabels = $state<Map<number, string>>(new Map());
    let ltcDerivedAddresses = $state<DerivedBtcForkAddress[]>([]);

    // Bitcoin Cash state (BTC fork)
    let bchAccounts = $state<BtcForkAccount[]>([]);
    let bchNewAddress = $state("");
    let bchNewLabel = $state("");
    let bchAddingAccount = $state(false);
    const bchBusy = $derived(taskQueue.isActive("bch-sync"));

    // XRP state
    let xrpAccounts = $state<XrpAccount[]>([]);
    let xrpNewAddress = $state("");
    let xrpNewLabel = $state("");
    let xrpAddingAccount = $state(false);
    const xrpBusy = $derived(taskQueue.isActive("xrp-sync"));
    let xrpPrivateKeyAck = $state(false);
    let xrpDeriveCount = $state(5);
    let xrpSelectedIndexes = $state<Set<number>>(new Set([0]));
    let xrpItemLabels = $state<Map<number, string>>(new Map());
    let xrpDerivedAddresses = $state<DerivedXrpAddress[]>([]);

    // TRON state
    let tronAccounts = $state<TronAccount[]>([]);
    let tronNewAddress = $state("");
    let tronNewLabel = $state("");
    let tronAddingAccount = $state(false);
    const tronBusy = $derived(taskQueue.isActive("tron-sync"));
    let tronPrivateKeyAck = $state(false);
    let tronDeriveCount = $state(5);
    let tronSelectedIndexes = $state<Set<number>>(new Set([0]));
    let tronItemLabels = $state<Map<number, string>>(new Map());
    let tronDerivedAddresses = $state<DerivedTronAddress[]>([]);

    // Stellar state
    let stellarAccounts = $state<StellarAccount[]>([]);
    let stellarNewAddress = $state("");
    let stellarNewLabel = $state("");
    let stellarAddingAccount = $state(false);
    const stellarBusy = $derived(taskQueue.isActive("stellar-sync"));
    let stellarPrivateKeyAck = $state(false);
    let stellarDeriveCount = $state(5);
    let stellarSelectedIndexes = $state<Set<number>>(new Set([0]));
    let stellarItemLabels = $state<Map<number, string>>(new Map());
    let stellarDerivedAddresses = $state<DerivedStellarAddress[]>([]);

    // Bittensor state
    let bittensorAccounts = $state<BittensorAccount[]>([]);
    let bittensorNewAddress = $state("");
    let bittensorNewLabel = $state("");
    let bittensorAddingAccount = $state(false);
    const bittensorBusy = $derived(taskQueue.isActive("bittensor-sync"));
    let bittensorPrivateKeyAck = $state(false);
    let bittensorDeriveCount = $state(5);
    let bittensorSelectedIndexes = $state<Set<number>>(new Set([0]));
    let bittensorItemLabels = $state<Map<number, string>>(new Map());
    let bittensorDerivedAddresses = $state<DerivedBittensorAddress[]>([]);

    // Hedera state
    let hederaAccounts = $state<HederaAccount[]>([]);
    let hederaNewAddress = $state("");
    let hederaNewLabel = $state("");
    let hederaAddingAccount = $state(false);
    const hederaBusy = $derived(taskQueue.isActive("hedera-sync"));
    let hederaPrivateKeyAck = $state(false);
    let hederaDeriveCount = $state(5);
    let hederaSelectedIndexes = $state<Set<number>>(new Set([0]));
    let hederaItemLabels = $state<Map<number, string>>(new Map());
    let hederaDerivedAddresses = $state<DerivedHederaAddress[]>([]);

    // NEAR state
    let nearAccounts = $state<NearAccount[]>([]);
    let nearNewAddress = $state("");
    let nearNewLabel = $state("");
    let nearAddingAccount = $state(false);
    const nearBusy = $derived(taskQueue.isActive("near-sync"));
    let nearPrivateKeyAck = $state(false);
    let nearDeriveCount = $state(5);
    let nearSelectedIndexes = $state<Set<number>>(new Set([0]));
    let nearItemLabels = $state<Map<number, string>>(new Map());
    let nearDerivedAddresses = $state<DerivedNearAddress[]>([]);

    // Algorand state
    let algorandAccounts = $state<AlgorandAccount[]>([]);
    let algorandNewAddress = $state("");
    let algorandNewLabel = $state("");
    let algorandAddingAccount = $state(false);
    const algorandBusy = $derived(taskQueue.isActive("algorand-sync"));
    let algorandPrivateKeyAck = $state(false);
    let algorandDeriveCount = $state(5);
    let algorandSelectedIndexes = $state<Set<number>>(new Set([0]));
    let algorandItemLabels = $state<Map<number, string>>(new Map());
    let algorandDerivedAddresses = $state<DerivedAlgorandAddress[]>([]);

    // Kaspa state
    let kaspaAccounts = $state<KaspaAccount[]>([]);
    let kaspaNewAddress = $state("");
    let kaspaNewLabel = $state("");
    let kaspaAddingAccount = $state(false);
    const kaspaBusy = $derived(taskQueue.isActive("kaspa-sync"));
    let kaspaPrivateKeyAck = $state(false);
    let kaspaDeriveCount = $state(5);
    let kaspaSelectedIndexes = $state<Set<number>>(new Set([0]));
    let kaspaItemLabels = $state<Map<number, string>>(new Map());
    let kaspaDerivedAddresses = $state<DerivedKaspaAddress[]>([]);

    // Zcash state
    let zcashAccounts = $state<ZcashAccount[]>([]);
    let zcashNewAddress = $state("");
    let zcashNewLabel = $state("");
    let zcashAddingAccount = $state(false);
    const zcashBusy = $derived(taskQueue.isActive("zcash-sync"));
    let zcashPrivateKeyAck = $state(false);
    let zcashDeriveCount = $state(5);
    let zcashSelectedIndexes = $state<Set<number>>(new Set([0]));
    let zcashItemLabels = $state<Map<number, string>>(new Map());
    let zcashDerivedAddresses = $state<DerivedZcashAddress[]>([]);

    // Stacks state
    let stacksAccounts = $state<StacksAccount[]>([]);
    let stacksNewAddress = $state("");
    let stacksNewLabel = $state("");
    let stacksAddingAccount = $state(false);
    const stacksBusy = $derived(taskQueue.isActive("stacks-sync"));
    let stacksPrivateKeyAck = $state(false);
    let stacksDeriveCount = $state(5);
    let stacksSelectedIndexes = $state<Set<number>>(new Set([0]));
    let stacksItemLabels = $state<Map<number, string>>(new Map());
    let stacksDerivedAddresses = $state<DerivedStacksAddress[]>([]);

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

    // Hyperliquid detection and derivation (EVM-compatible)
    const hlDetection = $derived.by(() => detectEvmInputType(hlNewAddress.trim()));
    const existingHlAddresses = $derived(new Set(hlAccounts.map(a => a.address.toLowerCase())));
    const hlShowAddressPicker = $derived((() => {
        const det = hlDetection;
        return det.type === "seed" && hlPrivateKeyAck && hlNewAddress.trim() !== "";
    })());
    const hlDerivedAddressesComputed = $derived.by(() => {
        if (!hlShowAddressPicker) return [];
        const input = hlNewAddress.trim();
        try { return deriveEvmAddressesFromSeed(input, hlDeriveCount); } catch { return []; }
    });
    $effect(() => { hlDerivedAddresses = hlDerivedAddressesComputed; });

    // Sui detection and derivation
    const suiDetection = $derived.by(() => detectSuiInputType(suiNewAddress.trim()));
    const existingSuiAddresses = $derived(new Set(suiAccounts.map(a => a.address.toLowerCase())));
    $effect(() => {
        const det = suiDetection;
        if (det.input_type !== "seed" || !suiPrivateKeyAck || !suiNewAddress.trim()) {
            suiDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveSuiAddresses(suiNewAddress.trim(), suiDeriveCount);
            suiDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingSuiAddresses.has(a.address.toLowerCase()));
            suiSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { suiDerivedAddresses = []; }
    });

    // Aptos detection and derivation
    const aptosDetection = $derived.by(() => detectAptosInputType(aptosNewAddress.trim()));
    const existingAptosAddresses = $derived(new Set(aptosAccounts.map(a => a.address.toLowerCase())));
    $effect(() => {
        const det = aptosDetection;
        if (det.input_type !== "seed" || !aptosPrivateKeyAck || !aptosNewAddress.trim()) {
            aptosDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveAptosAddresses(aptosNewAddress.trim(), aptosDeriveCount);
            aptosDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingAptosAddresses.has(a.address.toLowerCase()));
            aptosSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { aptosDerivedAddresses = []; }
    });

    // TON detection and derivation
    const tonDetection = $derived.by(() => detectTonInputType(tonNewAddress.trim()));
    const existingTonAddresses = $derived(new Set(tonAccounts.map(a => a.address)));
    $effect(() => {
        const det = tonDetection;
        if (det.input_type !== "seed" || !tonPrivateKeyAck || !tonNewAddress.trim()) {
            tonDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveTonAddresses(tonNewAddress.trim(), tonDeriveCount);
            tonDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingTonAddresses.has(a.address));
            tonSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { tonDerivedAddresses = []; }
    });

    // Tezos detection and derivation
    const tezosDetection = $derived.by(() => detectTezosInputType(tezosNewAddress.trim()));
    const existingTezosAddresses = $derived(new Set(tezosAccounts.map(a => a.address)));
    $effect(() => {
        const det = tezosDetection;
        if (det.input_type !== "seed" || !tezosPrivateKeyAck || !tezosNewAddress.trim()) {
            tezosDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveTezosAddresses(tezosNewAddress.trim(), tezosDeriveCount);
            tezosDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingTezosAddresses.has(a.address));
            tezosSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { tezosDerivedAddresses = []; }
    });

    // Cosmos detection and derivation
    const cosmosDetection = $derived.by(() => detectCosmosInputType(cosmosNewAddress.trim()));
    const existingCosmosAddresses = $derived(new Set(cosmosAccounts.map(a => a.address)));
    $effect(() => {
        const det = cosmosDetection;
        if (det.input_type !== "seed" || !cosmosPrivateKeyAck || !cosmosNewAddress.trim()) {
            cosmosDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveCosmosAddresses(cosmosNewAddress.trim(), cosmosDeriveCount);
            cosmosDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingCosmosAddresses.has(a.address));
            cosmosSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { cosmosDerivedAddresses = []; }
    });

    // Polkadot detection and derivation
    const polkadotDetection = $derived.by(() => detectPolkadotInputType(polkadotNewAddress.trim()));
    const existingPolkadotAddresses = $derived(new Set(polkadotAccounts.map(a => a.address)));
    $effect(() => {
        const det = polkadotDetection;
        if (det.input_type !== "seed" || !polkadotPrivateKeyAck || !polkadotNewAddress.trim()) {
            polkadotDerivedAddresses = [];
            return;
        }
        try {
            const results = derivePolkadotAddresses(polkadotNewAddress.trim(), polkadotDeriveCount);
            polkadotDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingPolkadotAddresses.has(a.address));
            polkadotSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { polkadotDerivedAddresses = []; }
    });

    // Dogecoin detection and derivation
    const dogeDetection = $derived.by(() => detectBtcForkInputType(BTC_FORK_CHAINS.doge, dogeNewAddress.trim()));
    const existingDogeAddresses = $derived(new Set(dogeAccounts.map(a => a.address)));
    $effect(() => {
        const det = dogeDetection;
        if (det.input_type !== "seed" || !dogePrivateKeyAck || !dogeNewAddress.trim()) {
            dogeDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveBtcForkAddresses(BTC_FORK_CHAINS.doge, dogeNewAddress.trim(), dogeDeriveCount);
            dogeDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingDogeAddresses.has(a.address));
            dogeSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { dogeDerivedAddresses = []; }
    });

    // Litecoin detection and derivation
    const ltcDetection = $derived.by(() => detectBtcForkInputType(BTC_FORK_CHAINS.ltc, ltcNewAddress.trim()));
    const existingLtcAddresses = $derived(new Set(ltcAccounts.map(a => a.address)));
    $effect(() => {
        const det = ltcDetection;
        if (det.input_type !== "seed" || !ltcPrivateKeyAck || !ltcNewAddress.trim()) {
            ltcDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveBtcForkAddresses(BTC_FORK_CHAINS.ltc, ltcNewAddress.trim(), ltcDeriveCount);
            ltcDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingLtcAddresses.has(a.address));
            ltcSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { ltcDerivedAddresses = []; }
    });

    // Bitcoin Cash detection (no derivation — CashAddr not supported)
    const bchDetection = $derived.by(() => detectBtcForkInputType(BTC_FORK_CHAINS.bch, bchNewAddress.trim()));
    const existingBchAddresses = $derived(new Set(bchAccounts.map(a => a.address)));

    // XRP detection and derivation
    const xrpDetection = $derived.by(() => detectXrpInputType(xrpNewAddress.trim()));
    const existingXrpAddresses = $derived(new Set(xrpAccounts.map(a => a.address)));
    $effect(() => {
        const det = xrpDetection;
        if (det.input_type !== "seed" || !xrpPrivateKeyAck || !xrpNewAddress.trim()) {
            xrpDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveXrpAddresses(xrpNewAddress.trim(), xrpDeriveCount);
            xrpDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingXrpAddresses.has(a.address));
            xrpSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { xrpDerivedAddresses = []; }
    });

    // TRON detection and derivation
    const tronDetection = $derived.by(() => detectTronInputType(tronNewAddress.trim()));
    const existingTronAddresses = $derived(new Set(tronAccounts.map(a => a.address)));
    $effect(() => {
        const det = tronDetection;
        if (det.input_type !== "seed" || !tronPrivateKeyAck || !tronNewAddress.trim()) {
            tronDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveTronAddresses(tronNewAddress.trim(), tronDeriveCount);
            tronDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingTronAddresses.has(a.address));
            tronSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { tronDerivedAddresses = []; }
    });

    // Stellar detection and derivation
    const stellarDetection = $derived.by(() => detectStellarInputType(stellarNewAddress.trim()));
    const existingStellarAddresses = $derived(new Set(stellarAccounts.map(a => a.address)));
    $effect(() => {
        const det = stellarDetection;
        if (det.input_type !== "seed" || !stellarPrivateKeyAck || !stellarNewAddress.trim()) {
            stellarDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveStellarAddresses(stellarNewAddress.trim(), stellarDeriveCount);
            stellarDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingStellarAddresses.has(a.address));
            stellarSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { stellarDerivedAddresses = []; }
    });

    // Bittensor detection and derivation
    const bittensorDetection = $derived.by(() => detectBittensorInputType(bittensorNewAddress.trim()));
    const existingBittensorAddresses = $derived(new Set(bittensorAccounts.map(a => a.address)));
    $effect(() => {
        const det = bittensorDetection;
        if (det.input_type !== "seed" || !bittensorPrivateKeyAck || !bittensorNewAddress.trim()) {
            bittensorDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveBittensorAddresses(bittensorNewAddress.trim(), bittensorDeriveCount);
            bittensorDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingBittensorAddresses.has(a.address));
            bittensorSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { bittensorDerivedAddresses = []; }
    });

    // Hedera detection and derivation
    const hederaDetection = $derived.by(() => detectHederaInputType(hederaNewAddress.trim()));
    const existingHederaAddresses = $derived(new Set(hederaAccounts.map(a => a.address)));
    $effect(() => {
        const det = hederaDetection;
        if (det.input_type !== "seed" || !hederaPrivateKeyAck || !hederaNewAddress.trim()) {
            hederaDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveHederaAddresses(hederaNewAddress.trim(), hederaDeriveCount);
            hederaDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingHederaAddresses.has(a.address));
            hederaSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { hederaDerivedAddresses = []; }
    });

    // NEAR detection and derivation
    const nearDetection = $derived.by(() => detectNearInputType(nearNewAddress.trim()));
    const existingNearAddresses = $derived(new Set(nearAccounts.map(a => a.address)));
    $effect(() => {
        const det = nearDetection;
        if (det.input_type !== "seed" || !nearPrivateKeyAck || !nearNewAddress.trim()) {
            nearDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveNearAddresses(nearNewAddress.trim(), nearDeriveCount);
            nearDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingNearAddresses.has(a.address));
            nearSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { nearDerivedAddresses = []; }
    });

    // Algorand detection and derivation
    const algorandDetection = $derived.by(() => detectAlgorandInputType(algorandNewAddress.trim()));
    const existingAlgorandAddresses = $derived(new Set(algorandAccounts.map(a => a.address)));
    $effect(() => {
        const det = algorandDetection;
        if (det.input_type !== "seed" || !algorandPrivateKeyAck || !algorandNewAddress.trim()) {
            algorandDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveAlgorandAddresses(algorandNewAddress.trim(), algorandDeriveCount);
            algorandDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingAlgorandAddresses.has(a.address));
            algorandSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { algorandDerivedAddresses = []; }
    });

    // Kaspa detection and derivation
    const kaspaDetection = $derived.by(() => detectKaspaInputType(kaspaNewAddress.trim()));
    const existingKaspaAddresses = $derived(new Set(kaspaAccounts.map(a => a.address)));
    $effect(() => {
        const det = kaspaDetection;
        if (det.input_type !== "seed" || !kaspaPrivateKeyAck || !kaspaNewAddress.trim()) {
            kaspaDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveKaspaAddresses(kaspaNewAddress.trim(), kaspaDeriveCount);
            kaspaDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingKaspaAddresses.has(a.address));
            kaspaSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { kaspaDerivedAddresses = []; }
    });

    // Zcash detection and derivation
    const zcashDetection = $derived.by(() => detectZcashInputType(zcashNewAddress.trim()));
    const existingZcashAddresses = $derived(new Set(zcashAccounts.map(a => a.address)));
    $effect(() => {
        const det = zcashDetection;
        if (det.input_type !== "seed" || !zcashPrivateKeyAck || !zcashNewAddress.trim()) {
            zcashDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveZcashAddresses(zcashNewAddress.trim(), zcashDeriveCount);
            zcashDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingZcashAddresses.has(a.address));
            zcashSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { zcashDerivedAddresses = []; }
    });

    // Stacks detection and derivation
    const stacksDetection = $derived.by(() => detectStacksInputType(stacksNewAddress.trim()));
    const existingStacksAddresses = $derived(new Set(stacksAccounts.map(a => a.address)));
    $effect(() => {
        const det = stacksDetection;
        if (det.input_type !== "seed" || !stacksPrivateKeyAck || !stacksNewAddress.trim()) {
            stacksDerivedAddresses = [];
            return;
        }
        try {
            const results = deriveStacksAddresses(stacksNewAddress.trim(), stacksDeriveCount);
            stacksDerivedAddresses = results;
            const firstUnknown = results.find(a => !existingStacksAddresses.has(a.address));
            stacksSelectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { stacksDerivedAddresses = []; }
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
        const input = hlNewAddress.trim();
        const baseLabel = hlNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        hlAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (hlDerivedAddresses.length > 0) {
                if (hlSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = hlDerivedAddresses
                    .filter(a => hlSelectedIndexes.has(a.index))
                    .filter(a => !existingHlAddresses.has(a.address.toLowerCase()));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                hlNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = hlItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 6)}...${address.slice(-4)}`);
                    await getBackend().addHyperliquidAccount({
                        id: uuidv7(),
                        address: address.toLowerCase(),
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                hlNewLabel = "";
                hlPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadHlAccounts();
                toast.success(`${selected.length} Hyperliquid address(es) added`);
                return;
            }

            // Single address path
            const address = input.toLowerCase();
            if (!/^0x[a-f0-9]{40}$/.test(address)) {
                toast.error("Invalid EVM address");
                return;
            }

            const existing = hlAccounts.find(a => a.address.toLowerCase() === address);
            if (existing) {
                toast.info("This address is already tracked on Hyperliquid");
                return;
            }

            await getBackend().addHyperliquidAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 6)}...${address.slice(-4)}`,
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

    // -- Sui functions --

    function startAddSui(prefillAddress?: string) {
        addSourceMode = "sui";
        if (prefillAddress) suiNewAddress = prefillAddress;
    }

    async function loadSuiAccounts() {
        try {
            suiAccounts = await getBackend().listSuiAccounts();
        } catch (err) {
            toast.error(`Failed to load Sui accounts: ${err}`);
        }
    }

    async function handleAddSuiAccount() {
        const input = suiNewAddress.trim();
        const baseLabel = suiNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        suiAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (suiDerivedAddresses.length > 0) {
                if (suiSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = suiDerivedAddresses
                    .filter(a => suiSelectedIndexes.has(a.index))
                    .filter(a => !existingSuiAddresses.has(a.address.toLowerCase()));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                suiNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = suiItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 6)}...${address.slice(-4)}`);
                    await getBackend().addSuiAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                suiNewLabel = "";
                suiPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadSuiAccounts();
                toast.success(`${selected.length} Sui address(es) added`);
                return;
            }

            // Single address path
            const address = input.toLowerCase();
            if (!/^0x[a-f0-9]{64}$/.test(address)) {
                toast.error("Invalid Sui address (expected 0x + 64 hex chars)");
                return;
            }

            const existing = suiAccounts.find(a => a.address.toLowerCase() === address);
            if (existing) {
                toast.info("This address is already tracked on Sui");
                return;
            }

            await getBackend().addSuiAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 6)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            suiNewAddress = "";
            suiNewLabel = "";
            addSourceMode = "idle";
            await loadSuiAccounts();
            toast.success("Sui account added");
        } catch (err) {
            toast.error(`Failed to add Sui account: ${err}`);
        } finally {
            suiAddingAccount = false;
        }
    }

    async function handleRemoveSuiAccount(id: string) {
        try {
            await getBackend().removeSuiAccount(id);
            await loadSuiAccounts();
            toast.success("Sui account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncSuiAccount(account: SuiAccount) {
        taskQueue.enqueue({
            key: `sui-sync:${account.id}`,
            label: `Sync ${account.label} (Sui)`,
            async run(ctx) {
                const r = await getBackend().syncSui(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadSuiAccounts();
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

    function syncAllSui() {
        for (const account of suiAccounts) {
            syncSuiAccount(account);
        }
    }

    // -- Aptos functions --

    function startAddAptos(prefillAddress?: string) {
        addSourceMode = "aptos";
        if (prefillAddress) aptosNewAddress = prefillAddress;
    }

    async function loadAptosAccounts() {
        try {
            aptosAccounts = await getBackend().listAptosAccounts();
        } catch (err) {
            toast.error(`Failed to load Aptos accounts: ${err}`);
        }
    }

    async function handleAddAptosAccount() {
        const input = aptosNewAddress.trim();
        const baseLabel = aptosNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        aptosAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (aptosDerivedAddresses.length > 0) {
                if (aptosSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = aptosDerivedAddresses
                    .filter(a => aptosSelectedIndexes.has(a.index))
                    .filter(a => !existingAptosAddresses.has(a.address.toLowerCase()));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                aptosNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = aptosItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 6)}...${address.slice(-4)}`);
                    await getBackend().addAptosAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                aptosNewLabel = "";
                aptosPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadAptosAccounts();
                toast.success(`${selected.length} Aptos address(es) added`);
                return;
            }

            // Single address path
            const address = input.toLowerCase();
            if (!/^0x[a-f0-9]{64}$/.test(address)) {
                toast.error("Invalid Aptos address (expected 0x + 64 hex chars)");
                return;
            }

            const existing = aptosAccounts.find(a => a.address.toLowerCase() === address);
            if (existing) {
                toast.info("This address is already tracked on Aptos");
                return;
            }

            await getBackend().addAptosAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 6)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            aptosNewAddress = "";
            aptosNewLabel = "";
            addSourceMode = "idle";
            await loadAptosAccounts();
            toast.success("Aptos account added");
        } catch (err) {
            toast.error(`Failed to add Aptos account: ${err}`);
        } finally {
            aptosAddingAccount = false;
        }
    }

    async function handleRemoveAptosAccount(id: string) {
        try {
            await getBackend().removeAptosAccount(id);
            await loadAptosAccounts();
            toast.success("Aptos account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncAptosAccount(account: AptosAccount) {
        taskQueue.enqueue({
            key: `aptos-sync:${account.id}`,
            label: `Sync ${account.label} (Aptos)`,
            async run(ctx) {
                const r = await getBackend().syncAptos(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadAptosAccounts();
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

    function syncAllAptos() {
        for (const account of aptosAccounts) {
            syncAptosAccount(account);
        }
    }

    // -- TON functions --

    function startAddTon(prefillAddress?: string) {
        addSourceMode = "ton";
        if (prefillAddress) tonNewAddress = prefillAddress;
    }

    async function loadTonAccounts() {
        try {
            tonAccounts = await getBackend().listTonAccounts();
        } catch (err) {
            toast.error(`Failed to load TON accounts: ${err}`);
        }
    }

    async function handleAddTonAccount() {
        const input = tonNewAddress.trim();
        const baseLabel = tonNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        tonAddingAccount = true;
        try {
            // Multi-index path (seed phrase derived)
            if (tonDerivedAddresses.length > 0) {
                if (tonSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = tonDerivedAddresses
                    .filter(a => tonSelectedIndexes.has(a.index))
                    .filter(a => !existingTonAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                tonNewAddress = "";
                for (const { index, address } of selected) {
                    const label = tonItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addTonAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                tonNewLabel = ""; tonPrivateKeyAck = false; addSourceMode = "idle";
                await loadTonAccounts();
                toast.success(`${selected.length} TON address(es) added`);
                return;
            }

            // Single address path
            const address = input;
            if (!/^[UE]Q[A-Za-z0-9_\-\/\+]{44,46}=?=?$/.test(address) && !/^-?[0-9]+:[0-9a-fA-F]{64}$/.test(address)) {
                toast.error("Invalid TON address");
                return;
            }

            const existing = tonAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on TON");
                return;
            }

            await getBackend().addTonAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            tonNewAddress = "";
            tonNewLabel = "";
            addSourceMode = "idle";
            await loadTonAccounts();
            toast.success("TON account added");
        } catch (err) {
            toast.error(`Failed to add TON account: ${err}`);
        } finally {
            tonAddingAccount = false;
        }
    }

    async function handleRemoveTonAccount(id: string) {
        try {
            await getBackend().removeTonAccount(id);
            await loadTonAccounts();
            toast.success("TON account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncTonAccount(account: TonAccount) {
        taskQueue.enqueue({
            key: `ton-sync:${account.id}`,
            label: `Sync ${account.label} (TON)`,
            async run(ctx) {
                const r = await getBackend().syncTon(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadTonAccounts();
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

    function syncAllTon() {
        for (const account of tonAccounts) {
            syncTonAccount(account);
        }
    }

    // -- Tezos functions --

    function startAddTezos(prefillAddress?: string) {
        addSourceMode = "tezos";
        if (prefillAddress) tezosNewAddress = prefillAddress;
    }

    async function loadTezosAccounts() {
        try {
            tezosAccounts = await getBackend().listTezosAccounts();
        } catch (err) {
            toast.error(`Failed to load Tezos accounts: ${err}`);
        }
    }

    async function handleAddTezosAccount() {
        const input = tezosNewAddress.trim();
        const baseLabel = tezosNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        tezosAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (tezosDerivedAddresses.length > 0) {
                if (tezosSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = tezosDerivedAddresses
                    .filter(a => tezosSelectedIndexes.has(a.index))
                    .filter(a => !existingTezosAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                tezosNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = tezosItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addTezosAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                tezosNewLabel = "";
                tezosPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadTezosAccounts();
                toast.success(`${selected.length} Tezos address(es) added`);
                return;
            }

            // Single address path
            const address = input;
            if (!/^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
                toast.error("Invalid Tezos address (expected tz1/tz2/tz3/tz4/KT1 format)");
                return;
            }

            const existing = tezosAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on Tezos");
                return;
            }

            await getBackend().addTezosAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            tezosNewAddress = "";
            tezosNewLabel = "";
            addSourceMode = "idle";
            await loadTezosAccounts();
            toast.success("Tezos account added");
        } catch (err) {
            toast.error(`Failed to add Tezos account: ${err}`);
        } finally {
            tezosAddingAccount = false;
        }
    }

    async function handleRemoveTezosAccount(id: string) {
        try {
            await getBackend().removeTezosAccount(id);
            await loadTezosAccounts();
            toast.success("Tezos account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncTezosAccount(account: TezosAccount) {
        taskQueue.enqueue({
            key: `tezos-sync:${account.id}`,
            label: `Sync ${account.label} (Tezos)`,
            async run(ctx) {
                const r = await getBackend().syncTezos(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadTezosAccounts();
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

    function syncAllTezos() {
        for (const account of tezosAccounts) {
            syncTezosAccount(account);
        }
    }

    // -- Cosmos functions --

    function startAddCosmos(prefillAddress?: string) {
        addSourceMode = "cosmos";
        if (prefillAddress) cosmosNewAddress = prefillAddress;
    }

    async function loadCosmosAccounts() {
        try {
            cosmosAccounts = await getBackend().listCosmosAccounts();
        } catch (err) {
            toast.error(`Failed to load Cosmos accounts: ${err}`);
        }
    }

    async function handleAddCosmosAccount() {
        const input = cosmosNewAddress.trim();
        const baseLabel = cosmosNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        cosmosAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (cosmosDerivedAddresses.length > 0) {
                if (cosmosSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = cosmosDerivedAddresses
                    .filter(a => cosmosSelectedIndexes.has(a.index))
                    .filter(a => !existingCosmosAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                cosmosNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = cosmosItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 12)}...${address.slice(-4)}`);
                    await getBackend().addCosmosAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                cosmosNewLabel = "";
                cosmosPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadCosmosAccounts();
                toast.success(`${selected.length} Cosmos address(es) added`);
                return;
            }

            // Single address path
            const address = input;
            if (!/^cosmos1[02-9ac-hj-np-z]{38}$/.test(address)) {
                toast.error("Invalid Cosmos address (expected cosmos1... format)");
                return;
            }

            const existing = cosmosAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on Cosmos");
                return;
            }

            await getBackend().addCosmosAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 12)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            cosmosNewAddress = "";
            cosmosNewLabel = "";
            addSourceMode = "idle";
            await loadCosmosAccounts();
            toast.success("Cosmos account added");
        } catch (err) {
            toast.error(`Failed to add Cosmos account: ${err}`);
        } finally {
            cosmosAddingAccount = false;
        }
    }

    async function handleRemoveCosmosAccount(id: string) {
        try {
            await getBackend().removeCosmosAccount(id);
            await loadCosmosAccounts();
            toast.success("Cosmos account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncCosmosAccount(account: CosmosAccount) {
        taskQueue.enqueue({
            key: `cosmos-sync:${account.id}`,
            label: `Sync ${account.label} (Cosmos)`,
            async run(ctx) {
                const r = await getBackend().syncCosmos(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadCosmosAccounts();
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

    function syncAllCosmos() {
        for (const account of cosmosAccounts) {
            syncCosmosAccount(account);
        }
    }

    // -- Polkadot functions --

    function startAddPolkadot(prefillAddress?: string) {
        addSourceMode = "polkadot";
        if (prefillAddress) polkadotNewAddress = prefillAddress;
    }

    async function loadPolkadotAccounts() {
        try {
            polkadotAccounts = await getBackend().listPolkadotAccounts();
        } catch (err) {
            toast.error(`Failed to load Polkadot accounts: ${err}`);
        }
    }

    async function handleAddPolkadotAccount() {
        const input = polkadotNewAddress.trim();
        const baseLabel = polkadotNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        polkadotAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (polkadotDerivedAddresses.length > 0) {
                if (polkadotSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = polkadotDerivedAddresses
                    .filter(a => polkadotSelectedIndexes.has(a.index))
                    .filter(a => !existingPolkadotAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                polkadotNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = polkadotItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addPolkadotAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                polkadotNewLabel = "";
                polkadotPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadPolkadotAccounts();
                toast.success(`${selected.length} Polkadot address(es) added`);
                return;
            }

            // Single address path
            const address = input;
            if (!/^1[1-9A-HJ-NP-Za-km-z]{45,47}$/.test(address)) {
                toast.error("Invalid Polkadot address (expected 1... format, 46-48 chars)");
                return;
            }

            const existing = polkadotAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on Polkadot");
                return;
            }

            await getBackend().addPolkadotAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            polkadotNewAddress = "";
            polkadotNewLabel = "";
            addSourceMode = "idle";
            await loadPolkadotAccounts();
            toast.success("Polkadot account added");
        } catch (err) {
            toast.error(`Failed to add Polkadot account: ${err}`);
        } finally {
            polkadotAddingAccount = false;
        }
    }

    async function handleRemovePolkadotAccount(id: string) {
        try {
            await getBackend().removePolkadotAccount(id);
            await loadPolkadotAccounts();
            toast.success("Polkadot account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncPolkadotAccount(account: PolkadotAccount) {
        taskQueue.enqueue({
            key: `polkadot-sync:${account.id}`,
            label: `Sync ${account.label} (Polkadot)`,
            async run(ctx) {
                const r = await getBackend().syncPolkadot(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadPolkadotAccounts();
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

    function syncAllPolkadot() {
        for (const account of polkadotAccounts) {
            syncPolkadotAccount(account);
        }
    }

    // -- Dogecoin functions --

    function startAddDoge(prefillAddress?: string) {
        addSourceMode = "doge";
        if (prefillAddress) dogeNewAddress = prefillAddress;
    }

    async function loadDogeAccounts() {
        try {
            dogeAccounts = await getBackend().listDogeAccounts();
        } catch (err) {
            toast.error(`Failed to load Dogecoin accounts: ${err}`);
        }
    }

    async function handleAddDogeAccount() {
        const input = dogeNewAddress.trim();
        const baseLabel = dogeNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        dogeAddingAccount = true;
        try {
            // Multi-index path: seed phrase with derived addresses
            if (dogeDerivedAddresses.length > 0) {
                if (dogeSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = dogeDerivedAddresses
                    .filter(a => dogeSelectedIndexes.has(a.index))
                    .filter(a => !existingDogeAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                dogeNewAddress = ""; // Clear private material immediately
                for (const { index, address } of selected) {
                    const label = dogeItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addDogeAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                dogeNewLabel = "";
                dogePrivateKeyAck = false;
                addSourceMode = "idle";
                await loadDogeAccounts();
                toast.success(`${selected.length} Dogecoin address(es) added`);
                return;
            }

            // Single address path
            const address = input;
            if (!(BTC_FORK_CHAINS.doge.addressRegex.test(address))) {
                toast.error("Invalid Dogecoin address");
                return;
            }

            const existing = dogeAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on Dogecoin");
                return;
            }

            await getBackend().addDogeAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            dogeNewAddress = "";
            dogeNewLabel = "";
            addSourceMode = "idle";
            await loadDogeAccounts();
            toast.success("Dogecoin account added");
        } catch (err) {
            toast.error(`Failed to add Dogecoin account: ${err}`);
        } finally {
            dogeAddingAccount = false;
        }
    }

    async function handleRemoveDogeAccount(id: string) {
        try {
            await getBackend().removeDogeAccount(id);
            await loadDogeAccounts();
            toast.success("Dogecoin account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncDogeAccount(account: BtcForkAccount) {
        taskQueue.enqueue({
            key: `doge-sync:${account.id}`,
            label: `Sync ${account.label} (Dogecoin)`,
            async run(ctx) {
                const r = await getBackend().syncDoge(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadDogeAccounts();
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

    function syncAllDoge() {
        for (const account of dogeAccounts) {
            syncDogeAccount(account);
        }
    }

    // -- Litecoin functions --

    function startAddLtc(prefillAddress?: string) {
        addSourceMode = "ltc";
        if (prefillAddress) ltcNewAddress = prefillAddress;
    }

    async function loadLtcAccounts() {
        try {
            ltcAccounts = await getBackend().listLtcAccounts();
        } catch (err) {
            toast.error(`Failed to load Litecoin accounts: ${err}`);
        }
    }

    async function handleAddLtcAccount() {
        const input = ltcNewAddress.trim();
        const baseLabel = ltcNewLabel.trim();
        if (!input) {
            toast.error("Input is required");
            return;
        }

        ltcAddingAccount = true;
        try {
            if (ltcDerivedAddresses.length > 0) {
                if (ltcSelectedIndexes.size === 0) {
                    toast.error("Select at least one address");
                    return;
                }
                const selected = ltcDerivedAddresses
                    .filter(a => ltcSelectedIndexes.has(a.index))
                    .filter(a => !existingLtcAddresses.has(a.address));
                if (selected.length === 0) {
                    toast.error("All selected addresses are already added");
                    return;
                }
                ltcNewAddress = "";
                for (const { index, address } of selected) {
                    const label = ltcItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addLtcAccount({
                        id: uuidv7(),
                        address,
                        label,
                        created_at: new Date().toISOString(),
                    });
                }
                ltcNewLabel = "";
                ltcPrivateKeyAck = false;
                addSourceMode = "idle";
                await loadLtcAccounts();
                toast.success(`${selected.length} Litecoin address(es) added`);
                return;
            }

            const address = input;
            if (!(BTC_FORK_CHAINS.ltc.addressRegex.test(address))) {
                toast.error("Invalid Litecoin address");
                return;
            }

            const existing = ltcAccounts.find(a => a.address === address);
            if (existing) {
                toast.info("This address is already tracked on Litecoin");
                return;
            }

            await getBackend().addLtcAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            ltcNewAddress = "";
            ltcNewLabel = "";
            addSourceMode = "idle";
            await loadLtcAccounts();
            toast.success("Litecoin account added");
        } catch (err) {
            toast.error(`Failed to add Litecoin account: ${err}`);
        } finally {
            ltcAddingAccount = false;
        }
    }

    async function handleRemoveLtcAccount(id: string) {
        try {
            await getBackend().removeLtcAccount(id);
            await loadLtcAccounts();
            toast.success("Litecoin account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncLtcAccount(account: BtcForkAccount) {
        taskQueue.enqueue({
            key: `ltc-sync:${account.id}`,
            label: `Sync ${account.label} (Litecoin)`,
            async run(ctx) {
                const r = await getBackend().syncLtc(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadLtcAccounts();
                if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
                if (r.transactions_imported > 0) {
                    enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet());
                }
                return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
            },
        });
    }

    function syncAllLtc() {
        for (const account of ltcAccounts) { syncLtcAccount(account); }
    }

    // -- Bitcoin Cash functions --

    function startAddBch(prefillAddress?: string) {
        addSourceMode = "bch";
        if (prefillAddress) bchNewAddress = prefillAddress;
    }

    async function loadBchAccounts() {
        try {
            bchAccounts = await getBackend().listBchAccounts();
        } catch (err) {
            toast.error(`Failed to load Bitcoin Cash accounts: ${err}`);
        }
    }

    async function handleAddBchAccount() {
        const input = bchNewAddress.trim();
        const baseLabel = bchNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }

        bchAddingAccount = true;
        try {
            const address = input;
            if (!(BTC_FORK_CHAINS.bch.addressRegex.test(address))) {
                toast.error("Invalid Bitcoin Cash address");
                return;
            }
            const existing = bchAccounts.find(a => a.address === address);
            if (existing) { toast.info("This address is already tracked on Bitcoin Cash"); return; }

            await getBackend().addBchAccount({
                id: uuidv7(),
                address,
                label: baseLabel || `${address.slice(0, 12)}...${address.slice(-4)}`,
                created_at: new Date().toISOString(),
            });
            bchNewAddress = "";
            bchNewLabel = "";
            addSourceMode = "idle";
            await loadBchAccounts();
            toast.success("Bitcoin Cash account added");
        } catch (err) {
            toast.error(`Failed to add Bitcoin Cash account: ${err}`);
        } finally {
            bchAddingAccount = false;
        }
    }

    async function handleRemoveBchAccount(id: string) {
        try {
            await getBackend().removeBchAccount(id);
            await loadBchAccounts();
            toast.success("Bitcoin Cash account removed");
        } catch (err) {
            toast.error(`Failed to remove: ${err}`);
        }
    }

    function syncBchAccount(account: BtcForkAccount) {
        taskQueue.enqueue({
            key: `bch-sync:${account.id}`,
            label: `Sync ${account.label} (Bitcoin Cash)`,
            async run(ctx) {
                const r = await getBackend().syncBch(
                    account,
                    (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }),
                    ctx.signal,
                );
                await loadBchAccounts();
                if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
                if (r.transactions_imported > 0) {
                    enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet());
                }
                return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
            },
        });
    }

    function syncAllBch() {
        for (const account of bchAccounts) { syncBchAccount(account); }
    }

    // -- XRP functions --

    function startAddXrp(prefillAddress?: string) {
        addSourceMode = "xrp";
        if (prefillAddress) xrpNewAddress = prefillAddress;
    }

    async function loadXrpAccounts() {
        try { xrpAccounts = await getBackend().listXrpAccounts(); }
        catch (err) { toast.error(`Failed to load XRP accounts: ${err}`); }
    }

    async function handleAddXrpAccount() {
        const input = xrpNewAddress.trim();
        const baseLabel = xrpNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }

        xrpAddingAccount = true;
        try {
            if (xrpDerivedAddresses.length > 0) {
                if (xrpSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = xrpDerivedAddresses.filter(a => xrpSelectedIndexes.has(a.index)).filter(a => !existingXrpAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                xrpNewAddress = "";
                for (const { index, address } of selected) {
                    const label = xrpItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addXrpAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                xrpNewLabel = ""; xrpPrivateKeyAck = false; addSourceMode = "idle";
                await loadXrpAccounts();
                toast.success(`${selected.length} XRP address(es) added`);
                return;
            }

            const address = input;
            if (!(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address))) { toast.error("Invalid XRP address"); return; }
            const existing = xrpAccounts.find(a => a.address === address);
            if (existing) { toast.info("This address is already tracked on XRP"); return; }

            await getBackend().addXrpAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            xrpNewAddress = ""; xrpNewLabel = ""; addSourceMode = "idle";
            await loadXrpAccounts();
            toast.success("XRP account added");
        } catch (err) { toast.error(`Failed to add XRP account: ${err}`); }
        finally { xrpAddingAccount = false; }
    }

    async function handleRemoveXrpAccount(id: string) {
        try { await getBackend().removeXrpAccount(id); await loadXrpAccounts(); toast.success("XRP account removed"); }
        catch (err) { toast.error(`Failed to remove: ${err}`); }
    }

    function syncXrpAccount(account: XrpAccount) {
        taskQueue.enqueue({
            key: `xrp-sync:${account.id}`,
            label: `Sync ${account.label} (XRP)`,
            async run(ctx) {
                const r = await getBackend().syncXrp(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
                await loadXrpAccounts();
                if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
                if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
                return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
            },
        });
    }

    function syncAllXrp() { for (const account of xrpAccounts) { syncXrpAccount(account); } }

    // -- TRON functions --

    function startAddTron(prefillAddress?: string) { addSourceMode = "tron"; if (prefillAddress) tronNewAddress = prefillAddress; }
    async function loadTronAccounts() { try { tronAccounts = await getBackend().listTronAccounts(); } catch (err) { toast.error(`Failed to load TRON accounts: ${err}`); } }

    async function handleAddTronAccount() {
        const input = tronNewAddress.trim(); const baseLabel = tronNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        tronAddingAccount = true;
        try {
            if (tronDerivedAddresses.length > 0) {
                if (tronSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = tronDerivedAddresses.filter(a => tronSelectedIndexes.has(a.index)).filter(a => !existingTronAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                tronNewAddress = "";
                for (const { index, address } of selected) {
                    const label = tronItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addTronAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                tronNewLabel = ""; tronPrivateKeyAck = false; addSourceMode = "idle";
                await loadTronAccounts(); toast.success(`${selected.length} TRON address(es) added`); return;
            }
            const address = input;
            if (!(/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))) { toast.error("Invalid TRON address"); return; }
            if (tronAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on TRON"); return; }
            await getBackend().addTronAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            tronNewAddress = ""; tronNewLabel = ""; addSourceMode = "idle"; await loadTronAccounts(); toast.success("TRON account added");
        } catch (err) { toast.error(`Failed to add TRON account: ${err}`); } finally { tronAddingAccount = false; }
    }

    async function handleRemoveTronAccount(id: string) { try { await getBackend().removeTronAccount(id); await loadTronAccounts(); toast.success("TRON account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncTronAccount(account: TronAccount) {
        taskQueue.enqueue({ key: `tron-sync:${account.id}`, label: `Sync ${account.label} (TRON)`, async run(ctx) {
            const r = await getBackend().syncTron(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadTronAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllTron() { for (const account of tronAccounts) { syncTronAccount(account); } }

    // -- Stellar functions --

    function startAddStellar(prefillAddress?: string) { addSourceMode = "stellar"; if (prefillAddress) stellarNewAddress = prefillAddress; }
    async function loadStellarAccounts() { try { stellarAccounts = await getBackend().listStellarAccounts(); } catch (err) { toast.error(`Failed to load Stellar accounts: ${err}`); } }

    async function handleAddStellarAccount() {
        const input = stellarNewAddress.trim(); const baseLabel = stellarNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        stellarAddingAccount = true;
        try {
            if (stellarDerivedAddresses.length > 0) {
                if (stellarSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = stellarDerivedAddresses.filter(a => stellarSelectedIndexes.has(a.index)).filter(a => !existingStellarAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                stellarNewAddress = "";
                for (const { index, address } of selected) {
                    const label = stellarItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addStellarAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                stellarNewLabel = ""; stellarPrivateKeyAck = false; addSourceMode = "idle";
                await loadStellarAccounts(); toast.success(`${selected.length} Stellar address(es) added`); return;
            }
            const address = input;
            if (!(/^G[A-Z2-7]{55}$/.test(address))) { toast.error("Invalid Stellar address"); return; }
            if (stellarAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Stellar"); return; }
            await getBackend().addStellarAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            stellarNewAddress = ""; stellarNewLabel = ""; addSourceMode = "idle"; await loadStellarAccounts(); toast.success("Stellar account added");
        } catch (err) { toast.error(`Failed to add Stellar account: ${err}`); } finally { stellarAddingAccount = false; }
    }

    async function handleRemoveStellarAccount(id: string) { try { await getBackend().removeStellarAccount(id); await loadStellarAccounts(); toast.success("Stellar account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncStellarAccount(account: StellarAccount) {
        taskQueue.enqueue({ key: `stellar-sync:${account.id}`, label: `Sync ${account.label} (Stellar)`, async run(ctx) {
            const r = await getBackend().syncStellar(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadStellarAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllStellar() { for (const account of stellarAccounts) { syncStellarAccount(account); } }

    // -- Bittensor functions --

    function startAddBittensor(prefillAddress?: string) { addSourceMode = "bittensor"; if (prefillAddress) bittensorNewAddress = prefillAddress; }
    async function loadBittensorAccounts() { try { bittensorAccounts = await getBackend().listBittensorAccounts(); } catch (err) { toast.error(`Failed to load Bittensor accounts: ${err}`); } }

    async function handleAddBittensorAccount() {
        const input = bittensorNewAddress.trim(); const baseLabel = bittensorNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        bittensorAddingAccount = true;
        try {
            if (bittensorDerivedAddresses.length > 0) {
                if (bittensorSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = bittensorDerivedAddresses.filter(a => bittensorSelectedIndexes.has(a.index)).filter(a => !existingBittensorAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                bittensorNewAddress = "";
                for (const { index, address } of selected) {
                    const label = bittensorItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addBittensorAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                bittensorNewLabel = ""; bittensorPrivateKeyAck = false; addSourceMode = "idle";
                await loadBittensorAccounts(); toast.success(`${selected.length} Bittensor address(es) added`); return;
            }
            const address = input;
            if (!(/^5[A-HJ-NP-Za-km-z1-9]{47}$/.test(address))) { toast.error("Invalid Bittensor address"); return; }
            if (bittensorAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Bittensor"); return; }
            await getBackend().addBittensorAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            bittensorNewAddress = ""; bittensorNewLabel = ""; addSourceMode = "idle"; await loadBittensorAccounts(); toast.success("Bittensor account added");
        } catch (err) { toast.error(`Failed to add Bittensor account: ${err}`); } finally { bittensorAddingAccount = false; }
    }

    async function handleRemoveBittensorAccount(id: string) { try { await getBackend().removeBittensorAccount(id); await loadBittensorAccounts(); toast.success("Bittensor account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncBittensorAccount(account: BittensorAccount) {
        taskQueue.enqueue({ key: `bittensor-sync:${account.id}`, label: `Sync ${account.label} (Bittensor)`, async run(ctx) {
            const r = await getBackend().syncBittensor(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadBittensorAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllBittensor() { for (const account of bittensorAccounts) { syncBittensorAccount(account); } }

    // -- Hedera functions --

    function startAddHedera(prefillAddress?: string) { addSourceMode = "hedera"; if (prefillAddress) hederaNewAddress = prefillAddress; }
    async function loadHederaAccounts() { try { hederaAccounts = await getBackend().listHederaAccounts(); } catch (err) { toast.error(`Failed to load Hedera accounts: ${err}`); } }

    async function handleAddHederaAccount() {
        const input = hederaNewAddress.trim(); const baseLabel = hederaNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        hederaAddingAccount = true;
        try {
            if (hederaDerivedAddresses.length > 0) {
                if (hederaSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = hederaDerivedAddresses.filter(a => hederaSelectedIndexes.has(a.index)).filter(a => !existingHederaAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                hederaNewAddress = "";
                for (const { index, address } of selected) {
                    const label = hederaItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address}`);
                    await getBackend().addHederaAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                hederaNewLabel = ""; hederaPrivateKeyAck = false; addSourceMode = "idle";
                await loadHederaAccounts(); toast.success(`${selected.length} Hedera account(s) added`); return;
            }
            const address = input;
            if (!(/^0\.0\.\d+$/.test(address))) { toast.error("Invalid Hedera address (expected 0.0.X format)"); return; }
            if (hederaAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Hedera"); return; }
            await getBackend().addHederaAccount({ id: uuidv7(), address, label: baseLabel || address, created_at: new Date().toISOString() });
            hederaNewAddress = ""; hederaNewLabel = ""; addSourceMode = "idle"; await loadHederaAccounts(); toast.success("Hedera account added");
        } catch (err) { toast.error(`Failed to add Hedera account: ${err}`); } finally { hederaAddingAccount = false; }
    }

    async function handleRemoveHederaAccount(id: string) { try { await getBackend().removeHederaAccount(id); await loadHederaAccounts(); toast.success("Hedera account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncHederaAccount(account: HederaAccount) {
        taskQueue.enqueue({ key: `hedera-sync:${account.id}`, label: `Sync ${account.label} (Hedera)`, async run(ctx) {
            const r = await getBackend().syncHedera(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadHederaAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllHedera() { for (const account of hederaAccounts) { syncHederaAccount(account); } }

    // -- NEAR functions --

    function startAddNear(prefillAddress?: string) { addSourceMode = "near"; if (prefillAddress) nearNewAddress = prefillAddress; }
    async function loadNearAccounts() { try { nearAccounts = await getBackend().listNearAccounts(); } catch (err) { toast.error(`Failed to load NEAR accounts: ${err}`); } }

    async function handleAddNearAccount() {
        const input = nearNewAddress.trim(); const baseLabel = nearNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        nearAddingAccount = true;
        try {
            if (nearDerivedAddresses.length > 0) {
                if (nearSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = nearDerivedAddresses.filter(a => nearSelectedIndexes.has(a.index)).filter(a => !existingNearAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                nearNewAddress = "";
                for (const { index, address } of selected) {
                    const label = nearItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addNearAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                nearNewLabel = ""; nearPrivateKeyAck = false; addSourceMode = "idle";
                await loadNearAccounts(); toast.success(`${selected.length} NEAR address(es) added`); return;
            }
            const address = input;
            if (!(/^([a-z0-9._-]+\.near|[0-9a-f]{64})$/.test(address))) { toast.error("Invalid NEAR address"); return; }
            if (nearAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on NEAR"); return; }
            await getBackend().addNearAccount({ id: uuidv7(), address, label: baseLabel || (address.includes(".near") ? address : `${address.slice(0, 8)}...${address.slice(-4)}`), created_at: new Date().toISOString() });
            nearNewAddress = ""; nearNewLabel = ""; addSourceMode = "idle"; await loadNearAccounts(); toast.success("NEAR account added");
        } catch (err) { toast.error(`Failed to add NEAR account: ${err}`); } finally { nearAddingAccount = false; }
    }

    async function handleRemoveNearAccount(id: string) { try { await getBackend().removeNearAccount(id); await loadNearAccounts(); toast.success("NEAR account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncNearAccount(account: NearAccount) {
        taskQueue.enqueue({ key: `near-sync:${account.id}`, label: `Sync ${account.label} (NEAR)`, async run(ctx) {
            const r = await getBackend().syncNear(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadNearAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllNear() { for (const account of nearAccounts) { syncNearAccount(account); } }

    // -- Algorand functions --

    function startAddAlgorand(prefillAddress?: string) { addSourceMode = "algorand"; if (prefillAddress) algorandNewAddress = prefillAddress; }
    async function loadAlgorandAccounts() { try { algorandAccounts = await getBackend().listAlgorandAccounts(); } catch (err) { toast.error(`Failed to load Algorand accounts: ${err}`); } }

    async function handleAddAlgorandAccount() {
        const input = algorandNewAddress.trim(); const baseLabel = algorandNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        algorandAddingAccount = true;
        try {
            if (algorandDerivedAddresses.length > 0) {
                if (algorandSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = algorandDerivedAddresses.filter(a => algorandSelectedIndexes.has(a.index)).filter(a => !existingAlgorandAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                algorandNewAddress = "";
                for (const { index, address } of selected) {
                    const label = algorandItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addAlgorandAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                algorandNewLabel = ""; algorandPrivateKeyAck = false; addSourceMode = "idle";
                await loadAlgorandAccounts(); toast.success(`${selected.length} Algorand address(es) added`); return;
            }
            const address = input;
            if (!(/^[A-Z2-7]{58}$/.test(address))) { toast.error("Invalid Algorand address"); return; }
            if (algorandAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Algorand"); return; }
            await getBackend().addAlgorandAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            algorandNewAddress = ""; algorandNewLabel = ""; addSourceMode = "idle"; await loadAlgorandAccounts(); toast.success("Algorand account added");
        } catch (err) { toast.error(`Failed to add Algorand account: ${err}`); } finally { algorandAddingAccount = false; }
    }

    async function handleRemoveAlgorandAccount(id: string) { try { await getBackend().removeAlgorandAccount(id); await loadAlgorandAccounts(); toast.success("Algorand account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncAlgorandAccount(account: AlgorandAccount) {
        taskQueue.enqueue({ key: `algorand-sync:${account.id}`, label: `Sync ${account.label} (Algorand)`, async run(ctx) {
            const r = await getBackend().syncAlgorand(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadAlgorandAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllAlgorand() { for (const account of algorandAccounts) { syncAlgorandAccount(account); } }

    // -- Kaspa functions --

    function startAddKaspa(prefillAddress?: string) { addSourceMode = "kaspa"; if (prefillAddress) kaspaNewAddress = prefillAddress; }
    async function loadKaspaAccounts() { try { kaspaAccounts = await getBackend().listKaspaAccounts(); } catch (err) { toast.error(`Failed to load Kaspa accounts: ${err}`); } }

    async function handleAddKaspaAccount() {
        const input = kaspaNewAddress.trim(); const baseLabel = kaspaNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        kaspaAddingAccount = true;
        try {
            if (kaspaDerivedAddresses.length > 0) {
                if (kaspaSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = kaspaDerivedAddresses.filter(a => kaspaSelectedIndexes.has(a.index)).filter(a => !existingKaspaAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                kaspaNewAddress = "";
                for (const { index, address } of selected) {
                    const label = kaspaItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 12)}...${address.slice(-4)}`);
                    await getBackend().addKaspaAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                kaspaNewLabel = ""; kaspaPrivateKeyAck = false; addSourceMode = "idle";
                await loadKaspaAccounts(); toast.success(`${selected.length} Kaspa address(es) added`); return;
            }
            const address = input;
            if (!(/^kaspa:[a-z0-9]{61,63}$/.test(address))) { toast.error("Invalid Kaspa address"); return; }
            if (kaspaAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Kaspa"); return; }
            await getBackend().addKaspaAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 12)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            kaspaNewAddress = ""; kaspaNewLabel = ""; addSourceMode = "idle"; await loadKaspaAccounts(); toast.success("Kaspa account added");
        } catch (err) { toast.error(`Failed to add Kaspa account: ${err}`); } finally { kaspaAddingAccount = false; }
    }

    async function handleRemoveKaspaAccount(id: string) { try { await getBackend().removeKaspaAccount(id); await loadKaspaAccounts(); toast.success("Kaspa account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncKaspaAccount(account: KaspaAccount) {
        taskQueue.enqueue({ key: `kaspa-sync:${account.id}`, label: `Sync ${account.label} (Kaspa)`, async run(ctx) {
            const r = await getBackend().syncKaspa(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadKaspaAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllKaspa() { for (const account of kaspaAccounts) { syncKaspaAccount(account); } }

    // -- Zcash functions --

    function startAddZcash(prefillAddress?: string) { addSourceMode = "zcash"; if (prefillAddress) zcashNewAddress = prefillAddress; }
    async function loadZcashAccounts() { try { zcashAccounts = await getBackend().listZcashAccounts(); } catch (err) { toast.error(`Failed to load Zcash accounts: ${err}`); } }

    async function handleAddZcashAccount() {
        const input = zcashNewAddress.trim(); const baseLabel = zcashNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        zcashAddingAccount = true;
        try {
            if (zcashDerivedAddresses.length > 0) {
                if (zcashSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = zcashDerivedAddresses.filter(a => zcashSelectedIndexes.has(a.index)).filter(a => !existingZcashAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                zcashNewAddress = "";
                for (const { index, address } of selected) {
                    const label = zcashItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addZcashAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                zcashNewLabel = ""; zcashPrivateKeyAck = false; addSourceMode = "idle";
                await loadZcashAccounts(); toast.success(`${selected.length} Zcash address(es) added`); return;
            }
            const address = input;
            if (!(/^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(address))) { toast.error("Invalid Zcash address"); return; }
            if (zcashAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Zcash"); return; }
            await getBackend().addZcashAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            zcashNewAddress = ""; zcashNewLabel = ""; addSourceMode = "idle"; await loadZcashAccounts(); toast.success("Zcash account added");
        } catch (err) { toast.error(`Failed to add Zcash account: ${err}`); } finally { zcashAddingAccount = false; }
    }

    async function handleRemoveZcashAccount(id: string) { try { await getBackend().removeZcashAccount(id); await loadZcashAccounts(); toast.success("Zcash account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncZcashAccount(account: ZcashAccount) {
        taskQueue.enqueue({ key: `zcash-sync:${account.id}`, label: `Sync ${account.label} (Zcash)`, async run(ctx) {
            const r = await getBackend().syncZcash(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadZcashAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllZcash() { for (const account of zcashAccounts) { syncZcashAccount(account); } }

    // -- Stacks functions --

    function startAddStacks(prefillAddress?: string) { addSourceMode = "stacks"; if (prefillAddress) stacksNewAddress = prefillAddress; }
    async function loadStacksAccounts() { try { stacksAccounts = await getBackend().listStacksAccounts(); } catch (err) { toast.error(`Failed to load Stacks accounts: ${err}`); } }

    async function handleAddStacksAccount() {
        const input = stacksNewAddress.trim(); const baseLabel = stacksNewLabel.trim();
        if (!input) { toast.error("Input is required"); return; }
        stacksAddingAccount = true;
        try {
            if (stacksDerivedAddresses.length > 0) {
                if (stacksSelectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = stacksDerivedAddresses.filter(a => stacksSelectedIndexes.has(a.index)).filter(a => !existingStacksAddresses.has(a.address));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                stacksNewAddress = "";
                for (const { index, address } of selected) {
                    const label = stacksItemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : `${address.slice(0, 8)}...${address.slice(-4)}`);
                    await getBackend().addStacksAccount({ id: uuidv7(), address, label, created_at: new Date().toISOString() });
                }
                stacksNewLabel = ""; stacksPrivateKeyAck = false; addSourceMode = "idle";
                await loadStacksAccounts(); toast.success(`${selected.length} Stacks address(es) added`); return;
            }
            const address = input;
            if (!(/^SP[0-9A-Z]{28,38}$/.test(address))) { toast.error("Invalid Stacks address"); return; }
            if (stacksAccounts.find(a => a.address === address)) { toast.info("This address is already tracked on Stacks"); return; }
            await getBackend().addStacksAccount({ id: uuidv7(), address, label: baseLabel || `${address.slice(0, 8)}...${address.slice(-4)}`, created_at: new Date().toISOString() });
            stacksNewAddress = ""; stacksNewLabel = ""; addSourceMode = "idle"; await loadStacksAccounts(); toast.success("Stacks account added");
        } catch (err) { toast.error(`Failed to add Stacks account: ${err}`); } finally { stacksAddingAccount = false; }
    }

    async function handleRemoveStacksAccount(id: string) { try { await getBackend().removeStacksAccount(id); await loadStacksAccounts(); toast.success("Stacks account removed"); } catch (err) { toast.error(`Failed to remove: ${err}`); } }

    function syncStacksAccount(account: StacksAccount) {
        taskQueue.enqueue({ key: `stacks-sync:${account.id}`, label: `Sync ${account.label} (Stacks)`, async run(ctx) {
            const r = await getBackend().syncStacks(account, (msg) => ctx.reportProgress({ current: 0, total: 0, message: msg }), ctx.signal);
            await loadStacksAccounts(); if (r.transactions_imported > 0) invalidate("journal", "accounts", "reports");
            if (r.transactions_imported > 0) { enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet()); }
            return { summary: `${r.transactions_imported} imported, ${r.transactions_skipped} skipped`, data: r };
        }});
    }

    function syncAllStacks() { for (const account of stacksAccounts) { syncStacksAccount(account); } }

    const anyBusy = $derived(cexBusy || ethBusy || btcBusy || solBusy || hlBusy || suiBusy || aptosBusy || tonBusy || tezosBusy || cosmosBusy || polkadotBusy || dogeBusy || ltcBusy || bchBusy || xrpBusy || tronBusy || stellarBusy || bittensorBusy || hederaBusy || nearBusy || algorandBusy || kaspaBusy || zcashBusy || stacksBusy);

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
        loadSuiAccounts();
        loadAptosAccounts();
        loadTonAccounts();
        loadTezosAccounts();
        loadCosmosAccounts();
        loadPolkadotAccounts();
        loadDogeAccounts();
        loadLtcAccounts();
        loadBchAccounts();
        loadXrpAccounts();
        loadTronAccounts();
        loadStellarAccounts();
        loadBittensorAccounts();
        loadHederaAccounts();
        loadNearAccounts();
        loadAlgorandAccounts();
        loadKaspaAccounts();
        loadZcashAccounts();
        loadStacksAccounts();
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
                    onSelectSui={startAddSui}
                    onSelectAptos={startAddAptos}
                    onSelectTon={startAddTon}
                    onSelectTezos={startAddTezos}
                    onSelectCosmos={startAddCosmos}
                    onSelectPolkadot={startAddPolkadot}
                    onSelectDoge={startAddDoge}
                    onSelectLtc={startAddLtc}
                    onSelectBch={startAddBch}
                    onSelectXrp={startAddXrp}
                    onSelectTron={startAddTron}
                    onSelectStellar={startAddStellar}
                    onSelectBittensor={startAddBittensor}
                    onSelectHedera={startAddHedera}
                    onSelectNear={startAddNear}
                    onSelectAlgorand={startAddAlgorand}
                    onSelectKaspa={startAddKaspa}
                    onSelectZcash={startAddZcash}
                    onSelectStacks={startAddStacks}
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
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
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

                    {#if hlDetection.type !== "unknown" && hlNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if hlDetection.isPrivate}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{hlDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{hlDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if hlDetection.isPrivate}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={hlPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if hlDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each hlDerivedAddresses as derived}
                                {@const exists = existingHlAddresses.has(derived.address.toLowerCase())}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={hlSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(hlSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            hlSelectedIndexes = next;
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
                                        value={hlItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(hlItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); hlItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: hlSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { hlDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "sui"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Sui Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Sui address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-sui-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-sui-address"
                                placeholder="0x..."
                                autocomplete="off"
                                bind:value={suiNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-sui-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-sui-label" placeholder="My Sui Wallet" bind:value={suiNewLabel} />
                        </div>
                        <Button onclick={handleAddSuiAccount} disabled={suiAddingAccount || (!suiNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if suiDetection.input_type !== "unknown" && suiNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if suiDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{suiDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{suiDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if suiDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={suiPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if suiDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each suiDerivedAddresses as derived}
                                {@const exists = existingSuiAddresses.has(derived.address.toLowerCase())}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={suiSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(suiSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            suiSelectedIndexes = next;
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
                                        value={suiItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(suiItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); suiItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: suiSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { suiDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "aptos"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Aptos Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track an Aptos address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-aptos-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-aptos-address"
                                placeholder="0x..."
                                autocomplete="off"
                                bind:value={aptosNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-aptos-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-aptos-label" placeholder="My Aptos Wallet" bind:value={aptosNewLabel} />
                        </div>
                        <Button onclick={handleAddAptosAccount} disabled={aptosAddingAccount || (!aptosNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if aptosDetection.input_type !== "unknown" && aptosNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if aptosDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{aptosDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{aptosDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if aptosDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={aptosPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if aptosDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each aptosDerivedAddresses as derived}
                                {@const exists = existingAptosAddresses.has(derived.address.toLowerCase())}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={aptosSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(aptosSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            aptosSelectedIndexes = next;
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
                                        value={aptosItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(aptosItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); aptosItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: aptosSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { aptosDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "ton"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add TON Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a TON address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-ton-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-ton-address"
                                placeholder="EQ... or UQ..."
                                autocomplete="off"
                                bind:value={tonNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-ton-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-ton-label" placeholder="My TON Wallet" bind:value={tonNewLabel} />
                        </div>
                        <Button onclick={handleAddTonAccount} disabled={tonAddingAccount || (!tonNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if tonDetection.input_type !== "unknown" && tonNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if tonDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{tonDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{tonDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if tonDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={tonPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if tonDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each tonDerivedAddresses as derived}
                                {@const exists = existingTonAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input type="checkbox" checked={tonSelectedIndexes.has(derived.index)} disabled={exists}
                                        onchange={() => { const next = new Set(tonSelectedIndexes); if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index); tonSelectedIndexes = next; }} />
                                    <span class="font-mono">{derived.index}</span>
                                    <span class="font-mono truncate flex-1">{derived.address}</span>
                                    <Button variant="ghost" size="sm" class="h-5 w-5 p-0" onclick={() => copyToClipboard(derived.address)}>
                                        <Copy class="h-3 w-3" />
                                    </Button>
                                    <Input class="h-6 w-24 text-xs" placeholder={m.label_label()} value={tonItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(tonItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); tonItemLabels = next; }} />
                                    {#if exists}<Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>{/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: tonSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { tonDeriveCount += 5; }}>{m.sources_load_more()}</Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "tezos"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Tezos Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Tezos address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-tezos-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-tezos-address"
                                placeholder="tz1..."
                                autocomplete="off"
                                bind:value={tezosNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-tezos-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-tezos-label" placeholder="My Tezos Wallet" bind:value={tezosNewLabel} />
                        </div>
                        <Button onclick={handleAddTezosAccount} disabled={tezosAddingAccount || (!tezosNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if tezosDetection.input_type !== "unknown" && tezosNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if tezosDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{tezosDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{tezosDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if tezosDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={tezosPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if tezosDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each tezosDerivedAddresses as derived}
                                {@const exists = existingTezosAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={tezosSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(tezosSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            tezosSelectedIndexes = next;
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
                                        value={tezosItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(tezosItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); tezosItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: tezosSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { tezosDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "cosmos"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Cosmos Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Cosmos address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-cosmos-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-cosmos-address"
                                placeholder="cosmos1..."
                                autocomplete="off"
                                bind:value={cosmosNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-cosmos-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-cosmos-label" placeholder="My Cosmos Wallet" bind:value={cosmosNewLabel} />
                        </div>
                        <Button onclick={handleAddCosmosAccount} disabled={cosmosAddingAccount || (!cosmosNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if cosmosDetection.input_type !== "unknown" && cosmosNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if cosmosDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{cosmosDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{cosmosDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if cosmosDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={cosmosPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if cosmosDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each cosmosDerivedAddresses as derived}
                                {@const exists = existingCosmosAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={cosmosSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(cosmosSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            cosmosSelectedIndexes = next;
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
                                        value={cosmosItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(cosmosItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); cosmosItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: cosmosSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { cosmosDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "polkadot"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Polkadot Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Polkadot address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-polkadot-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-polkadot-address"
                                placeholder="1..."
                                autocomplete="off"
                                bind:value={polkadotNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-polkadot-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-polkadot-label" placeholder="My Polkadot Wallet" bind:value={polkadotNewLabel} />
                        </div>
                        <Button onclick={handleAddPolkadotAccount} disabled={polkadotAddingAccount || (!polkadotNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if polkadotDetection.input_type !== "unknown" && polkadotNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if polkadotDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{polkadotDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{polkadotDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if polkadotDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={polkadotPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if polkadotDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each polkadotDerivedAddresses as derived}
                                {@const exists = existingPolkadotAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={polkadotSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(polkadotSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            polkadotSelectedIndexes = next;
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
                                        value={polkadotItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(polkadotItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); polkadotItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: polkadotSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { polkadotDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}


            {#if addSourceMode === "doge"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Dogecoin Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Dogecoin address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-doge-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-doge-address"
                                placeholder="D..."
                                autocomplete="off"
                                bind:value={dogeNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-doge-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-doge-label" placeholder="My Dogecoin Wallet" bind:value={dogeNewLabel} />
                        </div>
                        <Button onclick={handleAddDogeAccount} disabled={dogeAddingAccount || (!dogeNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if dogeDetection.input_type !== "unknown" && dogeNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if dogeDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{dogeDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{dogeDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if dogeDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={dogePrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if dogeDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each dogeDerivedAddresses as derived}
                                {@const exists = existingDogeAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={dogeSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(dogeSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            dogeSelectedIndexes = next;
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
                                        value={dogeItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(dogeItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); dogeItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: dogeSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { dogeDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "ltc"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Litecoin Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Litecoin address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-ltc-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-ltc-address"
                                placeholder="L... / M... / ltc1..."
                                autocomplete="off"
                                bind:value={ltcNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-ltc-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-ltc-label" placeholder="My Litecoin Wallet" bind:value={ltcNewLabel} />
                        </div>
                        <Button onclick={handleAddLtcAccount} disabled={ltcAddingAccount || (!ltcNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if ltcDetection.input_type !== "unknown" && ltcNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if ltcDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{ltcDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{ltcDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if ltcDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={ltcPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if ltcDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each ltcDerivedAddresses as derived}
                                {@const exists = existingLtcAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={ltcSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(ltcSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            ltcSelectedIndexes = next;
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
                                        value={ltcItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(ltcItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); ltcItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: ltcSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { ltcDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "bch"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Bitcoin Cash Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Bitcoin Cash address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-bch-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-bch-address"
                                placeholder="bitcoincash:q..."
                                autocomplete="off"
                                bind:value={bchNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-bch-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-bch-label" placeholder="My BCH Wallet" bind:value={bchNewLabel} />
                        </div>
                        <Button onclick={handleAddBchAccount} disabled={bchAddingAccount || (!bchNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>
                </div>
            {/if}

            {#if addSourceMode === "xrp"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add XRP Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a XRP address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-xrp-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-xrp-address"
                                placeholder="r..."
                                autocomplete="off"
                                bind:value={xrpNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-xrp-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-xrp-label" placeholder="My XRP Wallet" bind:value={xrpNewLabel} />
                        </div>
                        <Button onclick={handleAddXrpAccount} disabled={xrpAddingAccount || (!xrpNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if xrpDetection.input_type !== "unknown" && xrpNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if xrpDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{xrpDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{xrpDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if xrpDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={xrpPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if xrpDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each xrpDerivedAddresses as derived}
                                {@const exists = existingXrpAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={xrpSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(xrpSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            xrpSelectedIndexes = next;
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
                                        value={xrpItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(xrpItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); xrpItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: xrpSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { xrpDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "tron"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add TRON Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a TRON address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-tron-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-tron-address"
                                placeholder="T..."
                                autocomplete="off"
                                bind:value={tronNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-tron-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-tron-label" placeholder="My TRON Wallet" bind:value={tronNewLabel} />
                        </div>
                        <Button onclick={handleAddTronAccount} disabled={tronAddingAccount || (!tronNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if tronDetection.input_type !== "unknown" && tronNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if tronDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{tronDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{tronDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if tronDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={tronPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if tronDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each tronDerivedAddresses as derived}
                                {@const exists = existingTronAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={tronSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(tronSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            tronSelectedIndexes = next;
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
                                        value={tronItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(tronItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); tronItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: tronSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { tronDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "stellar"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Stellar Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Stellar address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-stellar-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-stellar-address"
                                placeholder="G..."
                                autocomplete="off"
                                bind:value={stellarNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-stellar-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-stellar-label" placeholder="My Stellar Wallet" bind:value={stellarNewLabel} />
                        </div>
                        <Button onclick={handleAddStellarAccount} disabled={stellarAddingAccount || (!stellarNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if stellarDetection.input_type !== "unknown" && stellarNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if stellarDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{stellarDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{stellarDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if stellarDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={stellarPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if stellarDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each stellarDerivedAddresses as derived}
                                {@const exists = existingStellarAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={stellarSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(stellarSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            stellarSelectedIndexes = next;
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
                                        value={stellarItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(stellarItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); stellarItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: stellarSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { stellarDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "bittensor"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Bittensor Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Bittensor address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-bittensor-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-bittensor-address"
                                placeholder="5..."
                                autocomplete="off"
                                bind:value={bittensorNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-bittensor-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-bittensor-label" placeholder="My Bittensor Wallet" bind:value={bittensorNewLabel} />
                        </div>
                        <Button onclick={handleAddBittensorAccount} disabled={bittensorAddingAccount || (!bittensorNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if bittensorDetection.input_type !== "unknown" && bittensorNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if bittensorDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{bittensorDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{bittensorDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if bittensorDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={bittensorPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if bittensorDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each bittensorDerivedAddresses as derived}
                                {@const exists = existingBittensorAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={bittensorSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(bittensorSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            bittensorSelectedIndexes = next;
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
                                        value={bittensorItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(bittensorItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); bittensorItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: bittensorSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { bittensorDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "hedera"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Hedera Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Hedera address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-hedera-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-hedera-address"
                                placeholder="0.0.X"
                                autocomplete="off"
                                bind:value={hederaNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-hedera-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-hedera-label" placeholder="My Hedera Account" bind:value={hederaNewLabel} />
                        </div>
                        <Button onclick={handleAddHederaAccount} disabled={hederaAddingAccount || (!hederaNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if hederaDetection.input_type !== "unknown" && hederaNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if hederaDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{hederaDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{hederaDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if hederaDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={hederaPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if hederaDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each hederaDerivedAddresses as derived}
                                {@const exists = existingHederaAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={hederaSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(hederaSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            hederaSelectedIndexes = next;
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
                                        value={hederaItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(hederaItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); hederaItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: hederaSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { hederaDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "near"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add NEAR Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a NEAR address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-near-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-near-address"
                                placeholder="alice.near / 64-char hex"
                                autocomplete="off"
                                bind:value={nearNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-near-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-near-label" placeholder="My NEAR Wallet" bind:value={nearNewLabel} />
                        </div>
                        <Button onclick={handleAddNearAccount} disabled={nearAddingAccount || (!nearNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if nearDetection.input_type !== "unknown" && nearNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if nearDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{nearDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{nearDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if nearDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={nearPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if nearDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each nearDerivedAddresses as derived}
                                {@const exists = existingNearAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={nearSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(nearSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            nearSelectedIndexes = next;
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
                                        value={nearItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(nearItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); nearItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: nearSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { nearDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "algorand"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Algorand Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Algorand address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-algorand-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-algorand-address"
                                placeholder="A-Z2-7 (58 chars)"
                                autocomplete="off"
                                bind:value={algorandNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-algorand-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-algorand-label" placeholder="My Algorand Wallet" bind:value={algorandNewLabel} />
                        </div>
                        <Button onclick={handleAddAlgorandAccount} disabled={algorandAddingAccount || (!algorandNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if algorandDetection.input_type !== "unknown" && algorandNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if algorandDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{algorandDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{algorandDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if algorandDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={algorandPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if algorandDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each algorandDerivedAddresses as derived}
                                {@const exists = existingAlgorandAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={algorandSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(algorandSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            algorandSelectedIndexes = next;
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
                                        value={algorandItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(algorandItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); algorandItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: algorandSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { algorandDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "kaspa"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Kaspa Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Kaspa address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-kaspa-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-kaspa-address"
                                placeholder="kaspa:..."
                                autocomplete="off"
                                bind:value={kaspaNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-kaspa-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-kaspa-label" placeholder="My Kaspa Wallet" bind:value={kaspaNewLabel} />
                        </div>
                        <Button onclick={handleAddKaspaAccount} disabled={kaspaAddingAccount || (!kaspaNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if kaspaDetection.input_type !== "unknown" && kaspaNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if kaspaDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{kaspaDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{kaspaDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if kaspaDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={kaspaPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if kaspaDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each kaspaDerivedAddresses as derived}
                                {@const exists = existingKaspaAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={kaspaSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(kaspaSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            kaspaSelectedIndexes = next;
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
                                        value={kaspaItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(kaspaItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); kaspaItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: kaspaSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { kaspaDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "zcash"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Zcash Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Zcash address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-zcash-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-zcash-address"
                                placeholder="t1... / t3..."
                                autocomplete="off"
                                bind:value={zcashNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-zcash-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-zcash-label" placeholder="My Zcash Wallet" bind:value={zcashNewLabel} />
                        </div>
                        <Button onclick={handleAddZcashAccount} disabled={zcashAddingAccount || (!zcashNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if zcashDetection.input_type !== "unknown" && zcashNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if zcashDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{zcashDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{zcashDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if zcashDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={zcashPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if zcashDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each zcashDerivedAddresses as derived}
                                {@const exists = existingZcashAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={zcashSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(zcashSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            zcashSelectedIndexes = next;
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
                                        value={zcashItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(zcashItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); zcashItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: zcashSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { zcashDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}

            {#if addSourceMode === "stacks"}
                <div class="space-y-3 rounded-lg border p-4">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">Add Stacks Account</span>
                        <Button variant="ghost" size="sm" onclick={cancelAdd}>
                            <X class="h-4 w-4" />
                        </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Track a Stacks address. All on-chain data is public — no API key needed.
                    </p>
                    <div class="flex items-end gap-2">
                        <div class="flex-1 space-y-1">
                            <label for="new-stacks-address" class="text-xs font-medium">Address</label>
                            <Input
                                id="new-stacks-address"
                                placeholder="SP..."
                                autocomplete="off"
                                bind:value={stacksNewAddress}
                            />
                        </div>
                        <div class="w-40 space-y-1">
                            <label for="new-stacks-label" class="text-xs font-medium">Label (optional)</label>
                            <Input id="new-stacks-label" placeholder="My Stacks Wallet" bind:value={stacksNewLabel} />
                        </div>
                        <Button onclick={handleAddStacksAccount} disabled={stacksAddingAccount || (!stacksNewAddress.trim())}>
                            <Plus class="mr-1 h-4 w-4" />
                            Add
                        </Button>
                    </div>

                    {#if stacksDetection.input_type !== "unknown" && stacksNewAddress.trim()}
                        <div class="flex items-center gap-2">
                            {#if stacksDetection.is_private}
                                <Badge variant="outline" class="border-amber-500 text-amber-700">{stacksDetection.description}</Badge>
                            {:else}
                                <Badge variant="outline" class="border-green-500 text-green-700">{stacksDetection.description}</Badge>
                            {/if}
                        </div>
                    {/if}

                    {#if stacksDetection.is_private}
                        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
                            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
                            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
                            <label class="mt-2 flex items-center gap-2">
                                <input type="checkbox" bind:checked={stacksPrivateKeyAck} />
                                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
                            </label>
                        </div>
                    {/if}

                    {#if stacksDerivedAddresses.length > 0}
                        <div class="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
                            {#each stacksDerivedAddresses as derived}
                                {@const exists = existingStacksAddresses.has(derived.address)}
                                <label class="flex items-center gap-2 text-xs {exists ? 'opacity-50' : ''}">
                                    <input
                                        type="checkbox"
                                        checked={stacksSelectedIndexes.has(derived.index)}
                                        disabled={exists}
                                        onchange={() => {
                                            const next = new Set(stacksSelectedIndexes);
                                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                                            stacksSelectedIndexes = next;
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
                                        value={stacksItemLabels.get(derived.index) ?? ""}
                                        oninput={(e) => { const next = new Map(stacksItemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); stacksItemLabels = next; }}
                                    />
                                    {#if exists}
                                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                                    {/if}
                                </label>
                            {/each}
                            <div class="flex items-center justify-between">
                                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: stacksSelectedIndexes.size })}</span>
                                <Button variant="outline" size="sm" onclick={() => { stacksDeriveCount += 5; }}>
                                    {m.sources_load_more()}
                                </Button>
                            </div>
                        </div>
                    {/if}
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
                                {:else if row.kind === "sui"}
                                    {@const suiAccount = row.data}
                                    {@const isSuiSyncing = taskQueue.isActive(`sui-sync:${suiAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {suiAccount.address.slice(0, 6)}...{suiAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{suiAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(suiAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === suiAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("sui"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {suiAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Sui</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Sui</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {suiAccount.last_sync
                                                ? new Date(suiAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncSuiAccount(suiAccount)}
                                                    disabled={suiBusy || editingRowId === suiAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isSuiSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === suiAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === suiAccount.id ? (editingRowId = null) : startEditLabel(suiAccount.id, suiAccount.label)} disabled={suiBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveSuiAccount(suiAccount.id)}
                                                    disabled={suiBusy || editingRowId === suiAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "aptos"}
                                    {@const aptosAccount = row.data}
                                    {@const isAptosSyncing = taskQueue.isActive(`aptos-sync:${aptosAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {aptosAccount.address.slice(0, 6)}...{aptosAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{aptosAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(aptosAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === aptosAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("aptos"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {aptosAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Aptos</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Aptos</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {aptosAccount.last_sync
                                                ? new Date(aptosAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncAptosAccount(aptosAccount)}
                                                    disabled={aptosBusy || editingRowId === aptosAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isAptosSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === aptosAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === aptosAccount.id ? (editingRowId = null) : startEditLabel(aptosAccount.id, aptosAccount.label)} disabled={aptosBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveAptosAccount(aptosAccount.id)}
                                                    disabled={aptosBusy || editingRowId === aptosAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "ton"}
                                    {@const tonAccount = row.data}
                                    {@const isTonSyncing = taskQueue.isActive(`ton-sync:${tonAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {tonAccount.address.slice(0, 8)}...{tonAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{tonAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(tonAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === tonAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("ton"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {tonAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">TON</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">TON</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {tonAccount.last_sync
                                                ? new Date(tonAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncTonAccount(tonAccount)}
                                                    disabled={tonBusy || editingRowId === tonAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isTonSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === tonAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === tonAccount.id ? (editingRowId = null) : startEditLabel(tonAccount.id, tonAccount.label)} disabled={tonBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveTonAccount(tonAccount.id)}
                                                    disabled={tonBusy || editingRowId === tonAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "tezos"}
                                    {@const tezosAccount = row.data}
                                    {@const isTezosSyncing = taskQueue.isActive(`tezos-sync:${tezosAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {tezosAccount.address.slice(0, 8)}...{tezosAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{tezosAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(tezosAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === tezosAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("tezos"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {tezosAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Tezos</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Tezos</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {tezosAccount.last_sync
                                                ? new Date(tezosAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncTezosAccount(tezosAccount)}
                                                    disabled={tezosBusy || editingRowId === tezosAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isTezosSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === tezosAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === tezosAccount.id ? (editingRowId = null) : startEditLabel(tezosAccount.id, tezosAccount.label)} disabled={tezosBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveTezosAccount(tezosAccount.id)}
                                                    disabled={tezosBusy || editingRowId === tezosAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "cosmos"}
                                    {@const cosmosAccount = row.data}
                                    {@const isCosmosSyncing = taskQueue.isActive(`cosmos-sync:${cosmosAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {cosmosAccount.address.slice(0, 12)}...{cosmosAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{cosmosAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(cosmosAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === cosmosAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("cosmos"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {cosmosAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Cosmos</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Cosmos</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {cosmosAccount.last_sync
                                                ? new Date(cosmosAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncCosmosAccount(cosmosAccount)}
                                                    disabled={cosmosBusy || editingRowId === cosmosAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isCosmosSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === cosmosAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === cosmosAccount.id ? (editingRowId = null) : startEditLabel(cosmosAccount.id, cosmosAccount.label)} disabled={cosmosBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveCosmosAccount(cosmosAccount.id)}
                                                    disabled={cosmosBusy || editingRowId === cosmosAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "polkadot"}
                                    {@const polkadotAccount = row.data}
                                    {@const isPolkadotSyncing = taskQueue.isActive(`polkadot-sync:${polkadotAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {polkadotAccount.address.slice(0, 8)}...{polkadotAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{polkadotAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(polkadotAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === polkadotAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("polkadot"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {polkadotAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Polkadot</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Polkadot</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {polkadotAccount.last_sync
                                                ? new Date(polkadotAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncPolkadotAccount(polkadotAccount)}
                                                    disabled={polkadotBusy || editingRowId === polkadotAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isPolkadotSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === polkadotAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === polkadotAccount.id ? (editingRowId = null) : startEditLabel(polkadotAccount.id, polkadotAccount.label)} disabled={polkadotBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemovePolkadotAccount(polkadotAccount.id)}
                                                    disabled={polkadotBusy || editingRowId === polkadotAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "doge"}
                                    {@const dogeAccount = row.data}
                                    {@const isDogeSyncing = taskQueue.isActive(`doge-sync:${dogeAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {dogeAccount.address.slice(0, 8)}...{dogeAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{dogeAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(dogeAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === dogeAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("doge"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {dogeAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Dogecoin</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Dogecoin</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {dogeAccount.last_sync
                                                ? new Date(dogeAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncDogeAccount(dogeAccount)}
                                                    disabled={dogeBusy || editingRowId === dogeAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isDogeSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === dogeAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === dogeAccount.id ? (editingRowId = null) : startEditLabel(dogeAccount.id, dogeAccount.label)} disabled={dogeBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveDogeAccount(dogeAccount.id)}
                                                    disabled={dogeBusy || editingRowId === dogeAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "ltc"}
                                    {@const ltcAccount = row.data}
                                    {@const isLtcSyncing = taskQueue.isActive(`ltc-sync:${ltcAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {ltcAccount.address.slice(0, 8)}...{ltcAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{ltcAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(ltcAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === ltcAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("ltc"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {ltcAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Litecoin</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Litecoin</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {ltcAccount.last_sync
                                                ? new Date(ltcAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncLtcAccount(ltcAccount)}
                                                    disabled={ltcBusy || editingRowId === ltcAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isLtcSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === ltcAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === ltcAccount.id ? (editingRowId = null) : startEditLabel(ltcAccount.id, ltcAccount.label)} disabled={ltcBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveLtcAccount(ltcAccount.id)}
                                                    disabled={ltcBusy || editingRowId === ltcAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "bch"}
                                    {@const bchAccount = row.data}
                                    {@const isBchSyncing = taskQueue.isActive(`bch-sync:${bchAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {bchAccount.address.slice(0, 12)}...{bchAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{bchAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(bchAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === bchAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("bch"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {bchAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Bitcoin Cash</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Bitcoin Cash</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {bchAccount.last_sync
                                                ? new Date(bchAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncBchAccount(bchAccount)}
                                                    disabled={bchBusy || editingRowId === bchAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isBchSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === bchAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === bchAccount.id ? (editingRowId = null) : startEditLabel(bchAccount.id, bchAccount.label)} disabled={bchBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveBchAccount(bchAccount.id)}
                                                    disabled={bchBusy || editingRowId === bchAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "xrp"}
                                    {@const xrpAccount = row.data}
                                    {@const isXrpSyncing = taskQueue.isActive(`xrp-sync:${xrpAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {xrpAccount.address.slice(0, 8)}...{xrpAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{xrpAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(xrpAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === xrpAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("xrp"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {xrpAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">XRP</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">XRP</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {xrpAccount.last_sync
                                                ? new Date(xrpAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncXrpAccount(xrpAccount)}
                                                    disabled={xrpBusy || editingRowId === xrpAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isXrpSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === xrpAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === xrpAccount.id ? (editingRowId = null) : startEditLabel(xrpAccount.id, xrpAccount.label)} disabled={xrpBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveXrpAccount(xrpAccount.id)}
                                                    disabled={xrpBusy || editingRowId === xrpAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "tron"}
                                    {@const tronAccount = row.data}
                                    {@const isTronSyncing = taskQueue.isActive(`tron-sync:${tronAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {tronAccount.address.slice(0, 8)}...{tronAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{tronAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(tronAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === tronAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("tron"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {tronAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">TRON</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">TRON</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {tronAccount.last_sync
                                                ? new Date(tronAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncTronAccount(tronAccount)}
                                                    disabled={tronBusy || editingRowId === tronAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isTronSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === tronAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === tronAccount.id ? (editingRowId = null) : startEditLabel(tronAccount.id, tronAccount.label)} disabled={tronBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveTronAccount(tronAccount.id)}
                                                    disabled={tronBusy || editingRowId === tronAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "stellar"}
                                    {@const stellarAccount = row.data}
                                    {@const isStellarSyncing = taskQueue.isActive(`stellar-sync:${stellarAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {stellarAccount.address.slice(0, 8)}...{stellarAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{stellarAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(stellarAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === stellarAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("stellar"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {stellarAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Stellar</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Stellar</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {stellarAccount.last_sync
                                                ? new Date(stellarAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncStellarAccount(stellarAccount)}
                                                    disabled={stellarBusy || editingRowId === stellarAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isStellarSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === stellarAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === stellarAccount.id ? (editingRowId = null) : startEditLabel(stellarAccount.id, stellarAccount.label)} disabled={stellarBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveStellarAccount(stellarAccount.id)}
                                                    disabled={stellarBusy || editingRowId === stellarAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "bittensor"}
                                    {@const bittensorAccount = row.data}
                                    {@const isBittensorSyncing = taskQueue.isActive(`bittensor-sync:${bittensorAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {bittensorAccount.address.slice(0, 8)}...{bittensorAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{bittensorAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(bittensorAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === bittensorAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("bittensor"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {bittensorAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Bittensor</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Bittensor</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {bittensorAccount.last_sync
                                                ? new Date(bittensorAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncBittensorAccount(bittensorAccount)}
                                                    disabled={bittensorBusy || editingRowId === bittensorAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isBittensorSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === bittensorAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === bittensorAccount.id ? (editingRowId = null) : startEditLabel(bittensorAccount.id, bittensorAccount.label)} disabled={bittensorBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveBittensorAccount(bittensorAccount.id)}
                                                    disabled={bittensorBusy || editingRowId === bittensorAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "hedera"}
                                    {@const hederaAccount = row.data}
                                    {@const isHederaSyncing = taskQueue.isActive(`hedera-sync:${hederaAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {hederaAccount.address}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{hederaAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(hederaAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === hederaAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("hedera"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {hederaAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Hedera</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Hedera</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {hederaAccount.last_sync
                                                ? new Date(hederaAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncHederaAccount(hederaAccount)}
                                                    disabled={hederaBusy || editingRowId === hederaAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isHederaSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === hederaAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === hederaAccount.id ? (editingRowId = null) : startEditLabel(hederaAccount.id, hederaAccount.label)} disabled={hederaBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveHederaAccount(hederaAccount.id)}
                                                    disabled={hederaBusy || editingRowId === hederaAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "near"}
                                    {@const nearAccount = row.data}
                                    {@const isNearSyncing = taskQueue.isActive(`near-sync:${nearAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {nearAccount.address.slice(0, 8)}...{nearAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{nearAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(nearAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === nearAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("near"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {nearAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">NEAR</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">NEAR</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {nearAccount.last_sync
                                                ? new Date(nearAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncNearAccount(nearAccount)}
                                                    disabled={nearBusy || editingRowId === nearAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isNearSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === nearAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === nearAccount.id ? (editingRowId = null) : startEditLabel(nearAccount.id, nearAccount.label)} disabled={nearBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveNearAccount(nearAccount.id)}
                                                    disabled={nearBusy || editingRowId === nearAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "algorand"}
                                    {@const algorandAccount = row.data}
                                    {@const isAlgorandSyncing = taskQueue.isActive(`algorand-sync:${algorandAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {algorandAccount.address.slice(0, 8)}...{algorandAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{algorandAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(algorandAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === algorandAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("algorand"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {algorandAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Algorand</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Algorand</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {algorandAccount.last_sync
                                                ? new Date(algorandAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncAlgorandAccount(algorandAccount)}
                                                    disabled={algorandBusy || editingRowId === algorandAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isAlgorandSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === algorandAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === algorandAccount.id ? (editingRowId = null) : startEditLabel(algorandAccount.id, algorandAccount.label)} disabled={algorandBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveAlgorandAccount(algorandAccount.id)}
                                                    disabled={algorandBusy || editingRowId === algorandAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "kaspa"}
                                    {@const kaspaAccount = row.data}
                                    {@const isKaspaSyncing = taskQueue.isActive(`kaspa-sync:${kaspaAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {kaspaAccount.address.slice(0, 12)}...{kaspaAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{kaspaAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(kaspaAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === kaspaAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("kaspa"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {kaspaAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Kaspa</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Kaspa</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {kaspaAccount.last_sync
                                                ? new Date(kaspaAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncKaspaAccount(kaspaAccount)}
                                                    disabled={kaspaBusy || editingRowId === kaspaAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isKaspaSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === kaspaAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === kaspaAccount.id ? (editingRowId = null) : startEditLabel(kaspaAccount.id, kaspaAccount.label)} disabled={kaspaBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveKaspaAccount(kaspaAccount.id)}
                                                    disabled={kaspaBusy || editingRowId === kaspaAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "zcash"}
                                    {@const zcashAccount = row.data}
                                    {@const isZcashSyncing = taskQueue.isActive(`zcash-sync:${zcashAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {zcashAccount.address.slice(0, 8)}...{zcashAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{zcashAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(zcashAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === zcashAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("zcash"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {zcashAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Zcash</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Zcash</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {zcashAccount.last_sync
                                                ? new Date(zcashAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncZcashAccount(zcashAccount)}
                                                    disabled={zcashBusy || editingRowId === zcashAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isZcashSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === zcashAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === zcashAccount.id ? (editingRowId = null) : startEditLabel(zcashAccount.id, zcashAccount.label)} disabled={zcashBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveZcashAccount(zcashAccount.id)}
                                                    disabled={zcashBusy || editingRowId === zcashAccount.id}
                                                >
                                                    <Trash2 class="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </Table.Cell>
                                    </Table.Row>
                                {:else if row.kind === "stacks"}
                                    {@const stacksAccount = row.data}
                                    {@const isStacksSyncing = taskQueue.isActive(`stacks-sync:${stacksAccount.id}`)}
                                    <Table.Row>
                                        <Table.Cell class="font-mono text-sm">
                                            <div class="flex items-center gap-1">
                                                <Tooltip.Root>
                                                    <Tooltip.Trigger class="truncate">
                                                        {stacksAccount.address.slice(0, 8)}...{stacksAccount.address.slice(-4)}
                                                    </Tooltip.Trigger>
                                                    <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{stacksAccount.address}</p></Tooltip.Content>
                                                </Tooltip.Root>
                                                <button onclick={() => copyToClipboard(stacksAccount.address)} class="shrink-0 text-muted-foreground hover:text-foreground" title={m.sources_copy()}>
                                                    <Copy class="h-3 w-3" />
                                                </button>
                                            </div>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {#if editingRowId === stacksAccount.id}
                                                <Input class="h-7 text-xs" bind:value={editingRowLabel} onkeydown={(e) => { if (e.key === "Enter") saveEditLabel("stacks"); if (e.key === "Escape") editingRowId = null; }} />
                                            {:else}
                                                {stacksAccount.label}
                                            {/if}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Stacks</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge variant="secondary">Stacks</Badge>
                                        </Table.Cell>
                                        <Table.Cell class="text-sm text-muted-foreground">
                                            {stacksAccount.last_sync
                                                ? new Date(stacksAccount.last_sync).toLocaleDateString()
                                                : m.sources_never()}
                                        </Table.Cell>
                                        <Table.Cell class="text-right">
                                            <div class="flex justify-end gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => syncStacksAccount(stacksAccount)}
                                                    disabled={stacksBusy || editingRowId === stacksAccount.id}
                                                >
                                                    <RefreshCw class="mr-1 h-3 w-3" />
                                                    {isStacksSyncing ? m.state_syncing() : m.sources_sync()}
                                                </Button>
                                                <Button variant={editingRowId === stacksAccount.id ? "default" : "outline"} size="sm" onclick={() => editingRowId === stacksAccount.id ? (editingRowId = null) : startEditLabel(stacksAccount.id, stacksAccount.label)} disabled={stacksBusy}>
                                                    <Pencil class="h-3 w-3" />
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onclick={() => handleRemoveStacksAccount(stacksAccount.id)}
                                                    disabled={stacksBusy || editingRowId === stacksAccount.id}
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
        {#if cexAccounts.length > 0 || ethAccounts.length > 0 || btcAccounts.length > 0 || suiAccounts.length > 0 || aptosAccounts.length > 0 || tonAccounts.length > 0 || tezosAccounts.length > 0}
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
