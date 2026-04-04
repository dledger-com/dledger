<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import { Button } from "$lib/components/ui/button/index.js";
    import { createDpriceClient, type DpriceAssetInfo } from "$lib/dprice-client.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { getBackend } from "$lib/backend.js";
    import { enqueueRateBackfill } from "$lib/exchange-rate-historical.js";
    import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import { toast } from "svelte-sonner";
    import Loader from "lucide-svelte/icons/loader";
    import * as m from "$paraglide/messages.js";

    let {
        currencyCode,
        open = $bindable(false),
    }: {
        currencyCode: string;
        open: boolean;
    } = $props();

    const settings = new SettingsStore();

    let loading = $state(false);
    let candidates = $state<DpriceAssetInfo[]>([]);
    let error = $state("");

    async function loadCandidates() {
        loading = true;
        error = "";
        candidates = [];
        try {
            const client = createDpriceClient({
                dpriceMode: settings.settings.dpriceMode,
                dpriceUrl: settings.settings.dpriceUrl,
            });
            candidates = await client.queryAssets({ symbol: currencyCode }, 10);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    async function select(asset: DpriceAssetInfo) {
        const backend = getBackend();
        await backend.setCurrencyRateOverride(
            currencyCode,
            "dprice",
            "user",
        );
        toast.success(
            m.toast_rate_source_updated({
                code: currencyCode,
                source: `dprice (${asset.name})`,
            }),
        );
        open = false;
        // Trigger rate sync to fetch the rates
        enqueueRateBackfill(
            taskQueue,
            backend,
            settings.buildRateConfig(),
            getHiddenCurrencySet(),
        );
    }

    $effect(() => {
        if (open) loadCandidates();
    });
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="max-w-lg">
        <Dialog.Header>
            <Dialog.Title
                >{m.dialog_select_dprice_title({
                    code: currencyCode,
                })}</Dialog.Title
            >
            <Dialog.Description>{currencyCode}</Dialog.Description>
        </Dialog.Header>
        <div class="space-y-2 max-h-80 overflow-y-auto">
            {#if loading}
                <div class="flex items-center justify-center py-8">
                    <Loader class="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            {:else if error}
                <p class="text-sm text-destructive py-4">{error}</p>
            {:else if candidates.length === 0}
                <p class="text-sm text-muted-foreground py-4">
                    {m.dialog_no_dprice_assets()}
                </p>
            {:else}
                {#each candidates as c}
                    <button
                        onclick={() => select(c)}
                        class="w-full text-left rounded-md border px-3 py-2 hover:bg-accent transition-colors cursor-pointer"
                    >
                        <div class="flex items-center justify-between">
                            <span class="font-medium text-sm">{c.name}</span>
                            {#if c.contract_chain}
                                <span
                                    class="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
                                    >{c.contract_chain}</span
                                >
                            {/if}
                        </div>
                        <div
                            class="flex items-center gap-3 text-xs text-muted-foreground mt-1"
                        >
                            <span class="font-mono truncate max-w-48"
                                >{c.id}</span
                            >
                            {#if c.first_price_date}
                                <span
                                    >{c.first_price_date} — {c.last_price_date ??
                                        "…"}</span
                                >
                            {:else}
                                <span class="text-amber-600 dark:text-amber-400"
                                    >{m.label_no_prices()}</span
                                >
                            {/if}
                        </div>
                    </button>
                {/each}
            {/if}
        </div>
    </Dialog.Content>
</Dialog.Root>
