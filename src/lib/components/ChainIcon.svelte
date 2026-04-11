<script lang="ts">
    import { getChainIconUrl, getNamedChainIconUrl } from "$lib/data/chain-icons.js";
    import { cacheExternalIcon, getCoinIconUrl, onCoinIconsChanged } from "$lib/data/coin-icons.svelte.js";
    import { getPluginManager } from "$lib/plugins/manager.js";

    let { chainId, chainName, size = 16 }: { chainId?: number; chainName?: string; size?: number } = $props();

    // Subscribe to icon cache updates for reactivity
    let _tick = $state(0);
    $effect(() => onCoinIconsChanged(() => _tick++));

    const cacheKey = $derived.by(() => {
        if (chainName) return `chain:${chainName.toLowerCase()}`;
        if (chainId != null) return `chain:${chainId}`;
        return null;
    });

    const externalUrl = $derived.by(() => {
        if (chainId != null) return getChainIconUrl(chainId);
        if (chainName) {
            const named = getNamedChainIconUrl(chainName);
            if (named) return named;
            // Fallback for plugin chains: use the native token's coin icon (fetched via CoinGecko)
            const ext = getPluginManager().blockchainSources.get(chainName);
            if (ext) return getCoinIconUrl(ext.symbol) ?? null;
        }
        return null;
    });

    const url = $derived.by(() => {
        void _tick; // reactive dependency on cache changes
        if (cacheKey && externalUrl) return cacheExternalIcon(cacheKey, externalUrl);
        return externalUrl;
    });

    let errored = $state(false);

    $effect(() => {
        void chainId;
        void chainName;
        errored = false;
    });

    function hashColor(s: string): string {
        let hash = 0;
        for (let i = 0; i < s.length; i++) {
            hash = s.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 45%, 65%)`;
    }

    const label = $derived(chainName ?? String(chainId ?? ""));
</script>

{#if url && !errored}
    <img
        src={url}
        alt=""
        class="rounded-full inline-block shrink-0 object-cover"
        style="width:{size}px;height:{size}px"
        loading="lazy"
        onerror={() => errored = true}
    />
{:else}
    <span
        class="rounded-full inline-flex items-center justify-center shrink-0 font-semibold text-white"
        style="width:{size}px;height:{size}px;font-size:{Math.max(size * 0.4, 8)}px;background:{hashColor(label)}"
    >
        {label.slice(0, 2)}
    </span>
{/if}
