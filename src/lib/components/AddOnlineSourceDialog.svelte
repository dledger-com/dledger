<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import * as Command from "$lib/components/ui/command/index.js";
    import * as Popover from "$lib/components/ui/popover/index.js";
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import { cn } from "$lib/utils.js";
    import { feedbackWizard } from "$lib/data/feedback.svelte.js";
    import MessageCircleQuestion from "lucide-svelte/icons/message-circle-question";
    import { getBackend } from "$lib/backend.js";
    import { toast } from "svelte-sonner";
    import { v7 as uuidv7 } from "uuid";
    import Plus from "lucide-svelte/icons/plus";
    import Check from "lucide-svelte/icons/check";
    import ChevronsUpDown from "lucide-svelte/icons/chevrons-up-down";
    import X from "lucide-svelte/icons/x";
    import Copy from "lucide-svelte/icons/copy";
    import RefreshCw from "lucide-svelte/icons/refresh-cw";
    import ArrowLeft from "lucide-svelte/icons/arrow-left";
    import { detectInputType, type QuickDetection } from "$lib/bitcoin/validate.js";
    import { detectEvmInputType, deriveEvmAddress, validateEvmSeedPhrase, deriveEvmAddressesFromSeed, deriveEvmAddressesFromXpub } from "$lib/evm/derive.js";
    import { detectBtcInputType, convertPrivateKey, deriveMultiXpubsFromSeed, deriveAddresses as deriveBtcAddressesFromXpub } from "$lib/bitcoin/derive.js";
    import { checkEvmActivity, checkBtcActivity } from "$lib/blockchain-activity.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import type { DerivedBtcXpub } from "$lib/bitcoin/derive.js";
    import { BLOCKCHAIN_CHAINS, getBlockchainConfig } from "$lib/blockchain-registry.js";
    import { SUPPORTED_CHAINS } from "$lib/types/index.js";
    import type { EtherscanAccount } from "$lib/types/index.js";
    import type { ExchangeAccount, ExchangeId } from "$lib/cex/types.js";
    import { getCexAdapter, getAllCexAdapters } from "$lib/cex/index.js";
    import type { BitcoinAccount } from "$lib/bitcoin/types.js";
    import AddSourceInput from "$lib/components/AddSourceInput.svelte";
    import BlockchainAddForm from "$lib/components/BlockchainAddForm.svelte";

    import { getPluginManager } from "$lib/plugins/manager.js";
    import type { GenericBlockchainAccount } from "$lib/backend.js";

    let {
        open = $bindable(false),
        existingCexAccounts = [],
        existingEthAccounts = [],
        existingBtcAccounts = [],
        chainStates = new Map(),
        pluginChainStates = new Map(),
        onAccountAdded,
    }: {
        open: boolean;
        existingCexAccounts?: ExchangeAccount[];
        existingEthAccounts?: EtherscanAccount[];
        existingBtcAccounts?: BitcoinAccount[];
        chainStates?: Map<string, { accounts: any[] }>;
        pluginChainStates?: Map<string, { accounts: GenericBlockchainAccount[] }>;
        onAccountAdded: () => void;
    } = $props();

    const EXCHANGE_NAMES = Object.fromEntries(
        getAllCexAdapters().map((a) => [a.exchangeId, a.exchangeName]),
    ) as Record<ExchangeId, string>;

    // -- Add source mode --
    type AddSourceMode = "idle" | "cex" | "blockchain" | "bitcoin" | string;
    let addSourceMode = $state<AddSourceMode>("idle");
    let addSourceExchangeId = $state<ExchangeId>("kraken");

    // -- CEX form fields --
    let cexNewLabel = $state("");
    let cexNewApiKey = $state("");
    let cexNewApiSecret = $state("");
    let cexNewPassphrase = $state("");
    let cexNewOpenedAt = $state("");
    let cexNewClosedAt = $state("");
    let cexAdding = $state(false);

    // -- EVM fields --
    let newAddress = $state("");
    let newLabel = $state("");
    let selectedChainIds = $state<Set<number>>(new Set([1]));
    let chainPopoverOpen = $state(false);
    let addingAccount = $state(false);
    let evmPrivateKeyAck = $state(false);
    let evmSeedPassphrase = $state("");
    let evmDeriveCount = $state(5);
    let evmSelectedIndexes = $state<Set<number>>(new Set([0]));
    let evmItemLabels = $state<Map<number, string>>(new Map());

    // -- BTC fields --
    let btcNewAddressOrXpub = $state("");
    let btcNewLabel = $state("");
    let btcPrivateKeyAck = $state(false);
    let btcSeedBip = $state(84);
    let btcSeedPassphrase = $state("");
    let btcAddingAccount = $state(false);
    let btcDeriveCount = $state(5);
    let btcSelectedIndexes = $state<Set<number>>(new Set([0]));
    let btcItemLabels = $state<Map<number, string>>(new Map());
    let btcDerivedXpubs = $state<DerivedBtcXpub[]>([]);
    let btcDeriving = $state(false);

    // -- Activity scanning --
    const settingsStore = new SettingsStore();
    let evmActivityStatus = $state<Map<number, boolean | null | "checking">>(new Map());
    let evmScanAbort = $state<AbortController | null>(null);
    let btcActivityStatus = $state<Map<number, boolean | null | "checking">>(new Map());
    let btcScanAbort = $state<AbortController | null>(null);

    // -- Derived state --
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

    // Existing-address sets for duplicate detection
    const existingEvmAddresses = $derived(new Set(existingEthAccounts.map(a => a.address.toLowerCase())));
    const existingBtcXpubs = $derived(new Set(existingBtcAccounts.map(a => a.address_or_xpub)));

    // Reset EVM activity status when derived addresses change
    $effect(() => {
        evmDerivedAddresses; // track
        evmActivityStatus = new Map();
    });

    // Auto-select first unknown index for EVM multi-index picker
    $effect(() => {
        const addrs = evmDerivedAddresses;
        if (addrs.length === 0) return;
        if (evmSelectedIndexes.size === 1 && evmSelectedIndexes.has(0)) {
            const firstUnknown = addrs.find(a => !existingEvmAddresses.has(a.address.toLowerCase()));
            if (firstUnknown && firstUnknown.index !== 0) {
                evmSelectedIndexes = new Set([firstUnknown.index]);
            } else if (!firstUnknown) {
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

    // Async derivation of multi-index xpubs from seed phrase
    $effect(() => {
        const input = btcNewAddressOrXpub.trim();
        const det = btcDetection;
        const ack = btcPrivateKeyAck;
        const bip = btcSeedBip;
        const pass = btcSeedPassphrase;
        const count = btcDeriveCount;

        // Reset BTC activity status on derivation change (avoid reading btcScanAbort here
        // as it would create a circular dependency that aborts scans immediately)
        btcActivityStatus = new Map();

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

    // -- Functions --
    function startAddCex(exchangeId: ExchangeId) {
        addSourceMode = "cex";
        addSourceExchangeId = exchangeId;
    }

    function startAddBlockchain(prefillAddress?: string) {
        addSourceMode = "blockchain";
        if (prefillAddress) newAddress = prefillAddress;
    }

    function startAddBitcoin(prefillInput?: string) {
        addSourceMode = "bitcoin";
        if (prefillInput) btcNewAddressOrXpub = prefillInput;
    }

    function startAddChain(chainId: string) {
        addSourceMode = chainId;
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
        evmScanAbort?.abort();
        evmScanAbort = null;
        evmActivityStatus = new Map();
        btcScanAbort?.abort();
        btcScanAbort = null;
        btcActivityStatus = new Map();
    }

    function generateCexLabel(exchangeId: ExchangeId): string {
        const name = EXCHANGE_NAMES[exchangeId];
        const existing = existingCexAccounts
            .filter((a) => a.exchange === exchangeId)
            .map((a) => a.label);
        if (!existing.includes(name)) return name;
        for (let i = 2; ; i++) {
            const candidate = `${name} ${i}`;
            if (!existing.includes(candidate)) return candidate;
        }
    }

    function ellipseAddress(addr: string): string {
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).then(() => {
            toast.success("Copied to clipboard");
        });
    }

    function toggleChain(chainId: number) {
        const next = new Set(selectedChainIds);
        if (next.has(chainId)) {
            next.delete(chainId);
        } else {
            next.add(chainId);
        }
        selectedChainIds = next;
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
            onAccountAdded();
            open = false;
            toast.success("Exchange account added");
        } catch (err) {
            toast.error(`Failed to add exchange account: ${err}`);
        } finally {
            cexAdding = false;
        }
    }

    async function handleAddEthAccount() {
        let addr = newAddress.trim();
        if (!addr) {
            toast.error("Address is required");
            return;
        }

        const detection = detectEvmInputType(addr);
        if (detection.type === "unknown") {
            toast.error("Unrecognized input -- enter an 0x address, private key, seed phrase, or xpub");
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
                onAccountAdded();
                open = false;
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
                onAccountAdded();
                open = false;
                toast.success(`Address added to ${selectedChainIds.size} chain(s)`);
            }
        } catch (err) {
            toast.error(String(err));
        } finally {
            addingAccount = false;
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
                cancelAdd();
                onAccountAdded();
                open = false;
                toast.success(`${selected.length} HD wallet(s) added`);
                return;
            }

            // Single-account path (xpub input, WIF, address, or non-seed private key)
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
                const conv = await convertPrivateKey(
                    input,
                    det.input_type === "seed" ? btcSeedBip : undefined,
                    det.input_type === "seed" ? btcSeedPassphrase : undefined,
                    network,
                );
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
                accountType = det.input_type as "xpub" | "ypub" | "zpub";
                derivationBip = det.suggested_bip ?? undefined;
            }

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
            cancelAdd();
            onAccountAdded();
            open = false;
            toast.success("Bitcoin account added");
        } catch (err) {
            toast.error(`Failed to add Bitcoin account: ${err}`);
        } finally {
            btcAddingAccount = false;
        }
    }

    async function scanEvmActivity() {
        if (evmDerivedAddresses.length === 0) return;
        const apiKey = settingsStore.etherscanApiKey;
        if (!apiKey) {
            toast.error("Etherscan API key required for activity scanning");
            return;
        }
        const abort = new AbortController();
        evmScanAbort = abort;
        const newStatus = new Map<number, boolean | null | "checking">();
        for (const d of evmDerivedAddresses) newStatus.set(d.index, "checking");
        evmActivityStatus = new Map(newStatus);

        const activeIndexes: number[] = [];
        for (const derived of evmDerivedAddresses) {
            if (abort.signal.aborted) break;
            try {
                const result = await checkEvmActivity(derived.address, apiKey, abort.signal);
                newStatus.set(derived.index, result);
                evmActivityStatus = new Map(newStatus);
                if (result === true) activeIndexes.push(derived.index);
            } catch {
                newStatus.set(derived.index, null);
                evmActivityStatus = new Map(newStatus);
            }
        }

        if (activeIndexes.length > 0 && !abort.signal.aborted) {
            evmSelectedIndexes = new Set(activeIndexes);
        }
        for (const [k, v] of newStatus) { if (v === "checking") newStatus.delete(k); }
        evmActivityStatus = new Map(newStatus);
        evmScanAbort = null;
    }

    function cancelEvmScan() {
        evmScanAbort?.abort();
        evmScanAbort = null;
    }

    async function scanBtcActivity() {
        if (btcDerivedXpubs.length === 0) return;
        const abort = new AbortController();
        btcScanAbort = abort;
        const bip = btcSeedBip;
        const xpubs = [...btcDerivedXpubs];
        const newStatus = new Map<number, boolean | null | "checking">();
        for (const xpub of xpubs) newStatus.set(xpub.index, "checking");
        btcActivityStatus = new Map(newStatus);

        const activeIndexes: number[] = [];
        for (const xpub of xpubs) {
            if (abort.signal.aborted) break;
            try {
                const addresses = await deriveBtcAddressesFromXpub(xpub.xpub, bip, 0, 0, 1, "mainnet");
                if (addresses.length > 0) {
                    const result = await checkBtcActivity(addresses[0], abort.signal);
                    newStatus.set(xpub.index, result);
                    if (result === true) activeIndexes.push(xpub.index);
                } else {
                    newStatus.set(xpub.index, null);
                }
            } catch {
                newStatus.set(xpub.index, null);
            }
            btcActivityStatus = new Map(newStatus);
        }

        if (activeIndexes.length > 0 && !abort.signal.aborted) {
            btcSelectedIndexes = new Set(activeIndexes);
        }
        // Clear any leftover "checking" spinners
        for (const [k, v] of newStatus) { if (v === "checking") newStatus.delete(k); }
        btcActivityStatus = new Map(newStatus);
        btcScanAbort = null;
    }

    function cancelBtcScan() {
        btcScanAbort?.abort();
        btcScanAbort = null;
    }

    function getDialogTitle(): string {
        if (addSourceMode === "idle") {
            return m.sources_add_online_source();
        } else if (addSourceMode === "cex") {
            return `${EXCHANGE_NAMES[addSourceExchangeId]} -- ${m.sources_add_exchange_account()}`;
        } else if (addSourceMode === "blockchain") {
            return m.sources_add_evm_address();
        } else if (addSourceMode === "bitcoin") {
            return m.sources_add_bitcoin();
        } else if (addSourceMode.startsWith("plugin:")) {
            const ext = getPluginManager().blockchainSources.get(addSourceMode.slice(7));
            if (ext) return `Add ${ext.chainName} Account`;
            return m.sources_add_account();
        } else {
            const chainConfig = BLOCKCHAIN_CHAINS.find(c => c.id === addSourceMode);
            if (chainConfig) return `Add ${chainConfig.name} Account`;
            return m.sources_add_account();
        }
    }
</script>

<Dialog.Root bind:open onOpenChange={(v) => { if (!v) cancelAdd(); }}>
    <Dialog.Content class="sm:max-w-2xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
        <Dialog.Header>
            <Dialog.Title>{getDialogTitle()}</Dialog.Title>
        </Dialog.Header>

        {#if addSourceMode !== "idle"}
            <Button variant="ghost" size="sm" class="w-fit" onclick={() => { addSourceMode = "idle"; }}>
                <ArrowLeft class="mr-1 h-4 w-4" />
                {m.btn_back()}
            </Button>
        {/if}

        {#if addSourceMode === "idle"}
            <AddSourceInput
                onSelectCex={startAddCex}
                onSelectBlockchain={startAddBlockchain}
                onSelectBitcoin={startAddBitcoin}
                onSelectSolana={() => startAddChain("sol")}
                onSelectHyperliquid={() => startAddChain("hl")}
                onSelectSui={() => startAddChain("sui")}
                onSelectAptos={() => startAddChain("aptos")}
                onSelectTon={() => startAddChain("ton")}
                onSelectTezos={() => startAddChain("tezos")}
                onSelectCosmos={() => startAddChain("cosmos")}
                onSelectPolkadot={() => startAddChain("polkadot")}
                onSelectDoge={() => startAddChain("doge")}
                onSelectLtc={() => startAddChain("ltc")}
                onSelectBch={() => startAddChain("bch")}
                onSelectXrp={() => startAddChain("xrp")}
                onSelectTron={() => startAddChain("tron")}
                onSelectStellar={() => startAddChain("stellar")}
                onSelectBittensor={() => startAddChain("bittensor")}
                onSelectHedera={() => startAddChain("hedera")}
                onSelectNear={() => startAddChain("near")}
                onSelectAlgorand={() => startAddChain("algorand")}
                onSelectKaspa={() => startAddChain("kaspa")}
                onSelectZcash={() => startAddChain("zcash")}
                onSelectStacks={() => startAddChain("stacks")}
                onSelectCardano={() => startAddChain("cardano")}
                onSelectMonero={() => startAddChain("xmr")}
                onSelectBitshares={() => startAddChain("bitshares")}
                onSelectPluginChain={(chainId) => { addSourceMode = `plugin:${chainId}`; }}
            />
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
              onclick={() => { open = false; feedbackWizard.openMissingSource(); }}
            >
              <MessageCircleQuestion class="h-3 w-3" />
              {m.feedback_missing_source_link()}
            </button>
        {:else if addSourceMode === "cex"}
            <div class="space-y-3">
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
            <div class="space-y-3">
                <div class="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
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
                        class="w-full sm:w-auto"
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
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-medium">{m.sources_derived_addresses()}</span>
                            {#if evmScanAbort}
                                <Button variant="outline" size="sm" onclick={cancelEvmScan}>
                                    <X class="mr-1 h-3 w-3" />
                                    {m.btn_cancel()}
                                </Button>
                            {:else}
                                <Button variant="outline" size="sm" onclick={scanEvmActivity}>
                                    <RefreshCw class="mr-1 h-3 w-3" />
                                    {m.sources_scan_activity()}
                                </Button>
                            {/if}
                        </div>
                        <div class="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border">
                            {#each evmDerivedAddresses as { index, address }}
                                {@const exists = existingEvmAddresses.has(address.toLowerCase())}
                                {@const evmStatus = evmActivityStatus.get(index)}
                                <label class="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 cursor-pointer min-w-0"
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
                                    {#if evmStatus === "checking"}
                                        <RefreshCw class="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
                                    {:else if evmStatus === true}
                                        <span class="h-2 w-2 rounded-full bg-green-500 shrink-0" title="Active"></span>
                                    {:else if evmStatus === false}
                                        <span class="h-2 w-2 rounded-full bg-muted-foreground/30 shrink-0" title="Empty"></span>
                                    {:else if evmStatus === null}
                                        <span class="text-xs text-muted-foreground shrink-0" title="Unknown">?</span>
                                    {/if}
                                    <div class="flex-1 w-0">
                                        <Tooltip.Root>
                                            <Tooltip.Trigger class="font-mono text-xs truncate block w-full text-left">{address}</Tooltip.Trigger>
                                            <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{address}</p></Tooltip.Content>
                                        </Tooltip.Root>
                                    </div>
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
                                class="w-full sm:w-[300px] justify-between"
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
            <div class="space-y-3">
                <div class="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
                    <div class="flex-1 space-y-1">
                        <label for="new-btc-input" class="text-xs font-medium">{m.sources_address_or_xpub()}</label>
                        <Input
                            id="new-btc-input"
                            placeholder={m.sources_paste_btc_placeholder()}
                            autocomplete="off"
                            bind:value={btcNewAddressOrXpub}
                        />
                    </div>
                    <div class="sm:w-40 space-y-1">
                        <label for="new-btc-label" class="text-xs font-medium">{m.sources_label_optional()}</label>
                        <Input
                            id="new-btc-label"
                            placeholder={m.sources_my_btc_wallet()}
                            bind:value={btcNewLabel}
                        />
                    </div>
                    <Button
                        class="w-full sm:w-auto"
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
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-medium">{m.sources_derived_hd_wallets()}</span>
                            {#if !btcDeriving}
                                {#if btcScanAbort}
                                    <Button variant="outline" size="sm" onclick={cancelBtcScan}>
                                        <X class="mr-1 h-3 w-3" />
                                        {m.btn_cancel()}
                                    </Button>
                                {:else}
                                    <Button variant="outline" size="sm" onclick={scanBtcActivity}>
                                        <RefreshCw class="mr-1 h-3 w-3" />
                                        {m.sources_scan_activity()}
                                    </Button>
                                {/if}
                            {/if}
                        </div>
                        {#if btcDeriving}
                            <div class="flex items-center gap-2 text-xs text-muted-foreground">
                                <RefreshCw class="h-3 w-3 animate-spin" />
                                {m.sources_deriving()}
                            </div>
                        {/if}
                        <div class="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border">
                            {#each btcDerivedXpubs as { index, xpub, keyType }}
                                {@const exists = existingBtcXpubs.has(xpub)}
                                {@const btcStatus = btcActivityStatus.get(index)}
                                <label class="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 cursor-pointer min-w-0"
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
                                    {#if btcStatus === "checking"}
                                        <RefreshCw class="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
                                    {:else if btcStatus === true}
                                        <span class="h-2 w-2 rounded-full bg-green-500 shrink-0" title="Active"></span>
                                    {:else if btcStatus === false}
                                        <span class="h-2 w-2 rounded-full bg-muted-foreground/30 shrink-0" title="Empty"></span>
                                    {:else if btcStatus === null}
                                        <span class="text-xs text-muted-foreground shrink-0" title="Unknown">?</span>
                                    {/if}
                                    <div class="flex-1 w-0">
                                        <Tooltip.Root>
                                            <Tooltip.Trigger class="font-mono text-xs truncate block w-full text-left">{xpub}</Tooltip.Trigger>
                                            <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{xpub}</p></Tooltip.Content>
                                        </Tooltip.Root>
                                    </div>
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

        {#if BLOCKCHAIN_CHAINS.some(c => c.id === addSourceMode)}
            {@const activeChainConfig = BLOCKCHAIN_CHAINS.find(c => c.id === addSourceMode)}
            {#if activeChainConfig}
                {@const existingAddrs = new Set((chainStates.get(activeChainConfig.id)?.accounts ?? []).map((a: any) => activeChainConfig.caseSensitive ? a.address : a.address.toLowerCase()))}
                <BlockchainAddForm
                    config={activeChainConfig}
                    existingAddresses={existingAddrs}
                    embedded
                    pluginChainId={activeChainConfig.generic ? activeChainConfig.id : undefined}
                    defaultExtra={activeChainConfig.defaultExtra}
                    onClose={() => { addSourceMode = "idle"; }}
                    onAccountAdded={async () => { onAccountAdded(); open = false; }}
                />
            {/if}
        {/if}

        {#if addSourceMode.startsWith("plugin:")}
            {@const pluginChainId = addSourceMode.slice(7)}
            {@const pluginExt = getPluginManager().blockchainSources.get(pluginChainId)}
            {#if pluginExt}
                {@const existingAddrs = new Set((pluginChainStates.get(pluginChainId)?.accounts ?? []).map(a => pluginExt.caseSensitive ? a.address : a.address.toLowerCase()))}
                {@const pluginConfig = { id: pluginExt.chainId, name: pluginExt.chainName, symbol: pluginExt.symbol, addressRegex: pluginExt.compiledRegex, addressPlaceholder: pluginExt.addressPlaceholder, addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: pluginExt.caseSensitive ?? false, backendList: "", backendAdd: "", backendRemove: "", backendUpdateLabel: "", backendSync: "", syncTaskPrefix: `plugin-${pluginExt.chainId}-sync`, detectInput: null, deriveAddresses: null }}
                <BlockchainAddForm
                    config={pluginConfig}
                    existingAddresses={existingAddrs}
                    embedded
                    pluginChainId={pluginChainId}
                    onClose={() => { addSourceMode = "idle"; }}
                    onAccountAdded={async () => { onAccountAdded(); open = false; }}
                />
            {/if}
        {/if}
    </Dialog.Content>
</Dialog.Root>
