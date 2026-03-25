<script lang="ts">
    import * as m from "$paraglide/messages.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { Badge } from "$lib/components/ui/badge/index.js";
    import * as Tooltip from "$lib/components/ui/tooltip/index.js";
    import { getBackend } from "$lib/backend.js";
    import { toast } from "svelte-sonner";
    import { v7 as uuidv7 } from "uuid";
    import Plus from "lucide-svelte/icons/plus";
    import X from "lucide-svelte/icons/x";
    import Copy from "lucide-svelte/icons/copy";
    import type { BlockchainConfig, InputDetection, DerivedAddress } from "$lib/blockchain-registry.js";

    let {
        config,
        existingAddresses = new Set<string>(),
        prefillAddress = "",
        embedded = false,
        onClose,
        onAccountAdded,
    }: {
        config: BlockchainConfig;
        existingAddresses?: Set<string>;
        prefillAddress?: string;
        embedded?: boolean;
        onClose: () => void;
        onAccountAdded: () => Promise<void>;
    } = $props();

    let address = $state(prefillAddress);
    let label = $state("");
    let adding = $state(false);
    let privateKeyAck = $state(false);
    let deriveCount = $state(5);
    let selectedIndexes = $state<Set<number>>(new Set([0]));
    let derivedAddresses = $state<DerivedAddress[]>([]);
    let itemLabels = $state<Map<number, string>>(new Map());

    // Detection
    const detection = $derived.by((): InputDetection => {
        if (!config.detectInput || !address.trim()) {
            return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
        }
        return config.detectInput(address.trim());
    });

    // Derivation
    $effect(() => {
        if (!config.deriveAddresses || detection.input_type !== "seed" || !privateKeyAck || !address.trim()) {
            derivedAddresses = [];
            return;
        }
        try {
            const results = config.deriveAddresses(address.trim(), deriveCount);
            derivedAddresses = results;
            const normalize = (a: string) => config.caseSensitive ? a : a.toLowerCase();
            const firstUnknown = results.find(a => !existingAddresses.has(normalize(a.address)));
            selectedIndexes = new Set(firstUnknown ? [firstUnknown.index] : []);
        } catch { derivedAddresses = []; }
    });

    function normalizeAddr(a: string): string {
        return config.caseSensitive ? a : a.toLowerCase();
    }

    function shortAddr(a: string): string {
        if (a.length <= config.addressSlicePrefix + config.addressSliceSuffix + 3) return a;
        return `${a.slice(0, config.addressSlicePrefix)}...${config.addressSliceSuffix > 0 ? a.slice(-config.addressSliceSuffix) : ""}`;
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text);
    }

    async function handleAdd() {
        const input = address.trim();
        const baseLabel = label.trim();
        if (!input) { toast.error("Input is required"); return; }

        adding = true;
        try {
            // Multi-index path (seed derived)
            if (derivedAddresses.length > 0) {
                if (selectedIndexes.size === 0) { toast.error("Select at least one address"); return; }
                const selected = derivedAddresses
                    .filter(a => selectedIndexes.has(a.index))
                    .filter(a => !existingAddresses.has(normalizeAddr(a.address)));
                if (selected.length === 0) { toast.error("All selected addresses are already added"); return; }
                address = ""; // Clear private material
                const backend = getBackend();
                for (const { index, addr } of selected.map(s => ({ index: s.index, addr: s.address }))) {
                    const lbl = itemLabels.get(index)?.trim() || (baseLabel ? `${baseLabel} #${index}` : shortAddr(addr));
                    await (backend as any)[config.backendAdd]({ id: uuidv7(), address: addr, label: lbl, created_at: new Date().toISOString() });
                }
                label = ""; privateKeyAck = false;
                await onAccountAdded();
                onClose();
                toast.success(`${selected.length} ${config.name} address(es) added`);
                return;
            }

            // Single address path
            const addr = config.caseSensitive ? input : input.toLowerCase();
            if (!config.addressRegex.test(addr) && !config.addressRegex.test(input)) {
                toast.error(`Invalid ${config.name} address`);
                return;
            }
            if (existingAddresses.has(normalizeAddr(addr)) || existingAddresses.has(normalizeAddr(input))) {
                toast.info(`This address is already tracked on ${config.name}`);
                return;
            }
            const backend = getBackend();
            await (backend as any)[config.backendAdd]({
                id: uuidv7(),
                address: config.caseSensitive ? input : addr,
                label: baseLabel || shortAddr(input),
                created_at: new Date().toISOString(),
            });
            address = ""; label = "";
            await onAccountAdded();
            onClose();
            toast.success(`${config.name} account added`);
        } catch (err) {
            toast.error(`Failed to add ${config.name} account: ${err}`);
        } finally {
            adding = false;
        }
    }
</script>

<div class={embedded ? "space-y-3" : "space-y-3 rounded-lg border p-4"}>
    {#if !embedded}
        <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Add {config.name} Account</span>
            <Button variant="ghost" size="sm" onclick={onClose}>
                <X class="h-4 w-4" />
            </Button>
        </div>
    {/if}
    <p class="text-xs text-muted-foreground">
        Track a {config.name} address. All on-chain data is public.
    </p>
    <div class="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
        <div class="flex-1 space-y-1">
            <label for="new-chain-address" class="text-xs font-medium">Address</label>
            <Input
                id="new-chain-address"
                placeholder={config.addressPlaceholder}
                autocomplete="off"
                bind:value={address}
            />
        </div>
        <div class="sm:w-40 space-y-1">
            <label for="new-chain-label" class="text-xs font-medium">Label (optional)</label>
            <Input id="new-chain-label" placeholder={`My ${config.name}`} bind:value={label} />
        </div>
        <Button class="w-full sm:w-auto" onclick={handleAdd} disabled={adding || (!address.trim())}>
            <Plus class="mr-1 h-4 w-4" />
            Add
        </Button>
    </div>

    {#if detection.input_type !== "unknown" && address.trim()}
        <div class="flex items-center gap-2">
            {#if detection.is_private}
                <Badge variant="outline" class="border-amber-500 text-amber-700">{detection.description}</Badge>
            {:else}
                <Badge variant="outline" class="border-green-500 text-green-700">{detection.description}</Badge>
            {/if}
        </div>
    {/if}

    {#if detection.is_private}
        <div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <p class="font-medium text-amber-800 dark:text-amber-200">{m.sources_private_key_detected()}</p>
            <p class="mt-1 text-amber-700 dark:text-amber-300">{m.sources_sol_private_key_warning()}</p>
            <label class="mt-2 flex items-center gap-2">
                <input type="checkbox" bind:checked={privateKeyAck} />
                <span class="text-amber-800 dark:text-amber-200">{m.sources_understand_derive_address()}</span>
            </label>
        </div>
    {/if}

    {#if derivedAddresses.length > 0}
        <div class="max-h-64 space-y-1 overflow-y-auto overflow-x-hidden rounded border p-2">
            {#each derivedAddresses as derived}
                {@const exists = existingAddresses.has(normalizeAddr(derived.address))}
                <label class="flex items-center gap-2 text-xs min-w-0 {exists ? 'opacity-50' : ''}">
                    <input
                        type="checkbox"
                        checked={selectedIndexes.has(derived.index)}
                        disabled={exists}
                        onchange={() => {
                            const next = new Set(selectedIndexes);
                            if (next.has(derived.index)) next.delete(derived.index); else next.add(derived.index);
                            selectedIndexes = next;
                        }}
                    />
                    <span class="font-mono">{derived.index}</span>
                    <Tooltip.Root>
                        <Tooltip.Trigger class="font-mono text-left truncate flex-1">{shortAddr(derived.address)}</Tooltip.Trigger>
                        <Tooltip.Content><p class="font-mono text-xs break-all max-w-80">{derived.address}</p></Tooltip.Content>
                    </Tooltip.Root>
                    <Button variant="ghost" size="sm" class="h-5 w-5 p-0" onclick={() => copyToClipboard(derived.address)}>
                        <Copy class="h-3 w-3" />
                    </Button>
                    <Input
                        class="h-6 w-24 text-xs"
                        placeholder={m.label_label()}
                        value={itemLabels.get(derived.index) ?? ""}
                        oninput={(e) => { const next = new Map(itemLabels); next.set(derived.index, (e.target as HTMLInputElement).value); itemLabels = next; }}
                    />
                    {#if exists}
                        <Badge variant="outline" class="text-xs">{m.sources_added()}</Badge>
                    {/if}
                </label>
            {/each}
            <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">{m.sources_addresses_selected({ count: selectedIndexes.size })}</span>
                <Button variant="outline" size="sm" onclick={() => { deriveCount += 5; }}>{m.sources_load_more()}</Button>
            </div>
        </div>
    {/if}
</div>
