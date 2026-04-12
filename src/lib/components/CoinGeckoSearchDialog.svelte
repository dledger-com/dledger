<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog/index.js";
    import { Input } from "$lib/components/ui/input/index.js";
    import { getBackend } from "$lib/backend.js";
    import { SettingsStore } from "$lib/data/settings.svelte.js";
    import { enqueueRateBackfill } from "$lib/exchange-rate-historical.js";
    import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
    import { taskQueue } from "$lib/task-queue.svelte.js";
    import { toast } from "svelte-sonner";
    import Loader from "lucide-svelte/icons/loader";
    import Search from "lucide-svelte/icons/search";

    let {
        currencyCode,
        open = $bindable(false),
    }: {
        currencyCode: string;
        open: boolean;
    } = $props();

    const settings = new SettingsStore();

    let query = $state("");
    let results = $state<Array<{ id: string; name: string; symbol: string; thumb: string; market_cap_rank: number | null }>>([]);
    let loading = $state(false);
    let error = $state("");
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    function buildUrl(path: string): string {
        return settings.settings.coingeckoPro
            ? `https://pro-api.coingecko.com/api/v3${path}`
            : `https://api.coingecko.com/api/v3${path}`;
    }

    function buildHeaders(): Record<string, string> {
        const key = settings.coingeckoApiKey;
        if (!key) return {};
        return settings.settings.coingeckoPro
            ? { "x-cg-pro-api-key": key }
            : { "x-cg-demo-api-key": key };
    }

    async function search(q: string) {
        if (q.length < 2) { results = []; return; }
        loading = true;
        error = "";
        try {
            const resp = await fetch(
                buildUrl(`/search?query=${encodeURIComponent(q)}`),
                { headers: buildHeaders(), signal: AbortSignal.timeout(10_000) },
            );
            if (!resp.ok) { error = `HTTP ${resp.status}`; return; }
            const data = await resp.json();
            results = (data.coins ?? []).slice(0, 10).map((c: any) => ({
                id: c.id,
                name: c.name,
                symbol: c.symbol,
                thumb: c.thumb,
                market_cap_rank: c.market_cap_rank ?? null,
            }));
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    function handleInput(q: string) {
        query = q;
        clearTimeout(searchTimer);
        if (q.length < 2) { results = []; return; }
        searchTimer = setTimeout(() => search(q), 300);
    }

    async function select(coin: typeof results[number]) {
        const backend = getBackend();
        // Store the resolved CoinGecko ID
        await backend.setCryptoAssetCoingeckoId(currencyCode, coin.id);
        // Set rate source to coingecko
        await backend.setCurrencyRateOverride(currencyCode, "coingecko", "user");
        toast.success(`${currencyCode} linked to ${coin.name} (${coin.id})`);
        open = false;
        // Trigger rate sync
        enqueueRateBackfill(
            taskQueue,
            backend,
            settings.buildRateConfig(),
            getHiddenCurrencySet(),
        );
    }

    $effect(() => {
        if (open) {
            query = currencyCode;
            results = [];
            error = "";
            search(currencyCode);
        }
    });
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="max-w-lg">
        <Dialog.Header>
            <Dialog.Title>Link {currencyCode} to CoinGecko</Dialog.Title>
            <Dialog.Description>Search for the correct coin to use for price data</Dialog.Description>
        </Dialog.Header>
        <div class="relative">
            <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
                class="pl-8"
                placeholder="Search by name or symbol..."
                value={query}
                oninput={(e) => handleInput((e.target as HTMLInputElement).value)}
            />
        </div>
        <div class="space-y-1 max-h-80 overflow-y-auto mt-2">
            {#if loading}
                <div class="flex items-center justify-center py-8">
                    <Loader class="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            {:else if error}
                <p class="text-sm text-destructive py-4">{error}</p>
            {:else if results.length === 0 && query.length >= 2}
                <p class="text-sm text-muted-foreground py-4">No coins found</p>
            {:else}
                {#each results as coin}
                    <button
                        onclick={() => select(coin)}
                        class="w-full text-left rounded-md border px-3 py-2 hover:bg-accent transition-colors cursor-pointer"
                    >
                        <div class="flex items-center gap-2">
                            {#if coin.thumb}
                                <img src={coin.thumb} alt="" class="h-5 w-5 rounded-full" />
                            {/if}
                            <span class="font-medium text-sm">{coin.name}</span>
                            <span class="text-xs text-muted-foreground uppercase">{coin.symbol}</span>
                            {#if coin.market_cap_rank}
                                <span class="text-xs text-muted-foreground ml-auto">#{coin.market_cap_rank}</span>
                            {/if}
                        </div>
                        <div class="text-xs text-muted-foreground mt-0.5 font-mono">{coin.id}</div>
                    </button>
                {/each}
            {/if}
        </div>
    </Dialog.Content>
</Dialog.Root>
