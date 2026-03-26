<script lang="ts">
    import { getExchangeIconUrl } from "$lib/data/exchange-icons.js";
    import { INSTITUTION_REGISTRY } from "$lib/cex/institution-registry.js";
    import { cacheExternalIcon, onCoinIconsChanged } from "$lib/data/coin-icons.svelte.js";

    let { exchangeId, size = 16 }: { exchangeId: string; size?: number } = $props();

    const rawUrl = $derived(getExchangeIconUrl(exchangeId));

    const faviconRawUrl = $derived.by(() => {
        const info = INSTITUTION_REGISTRY[exchangeId];
        if (info?.url) return `https://www.google.com/s2/favicons?domain=${info.url}&sz=32`;
        return null;
    });

    // Subscribe to icon cache updates for reactivity
    let _tick = $state(0);
    $effect(() => onCoinIconsChanged(() => _tick++));

    const url = $derived.by(() => {
        void _tick;
        if (rawUrl) return cacheExternalIcon(`exchange:${exchangeId}`, rawUrl);
        return null;
    });

    const faviconUrl = $derived.by(() => {
        void _tick;
        if (faviconRawUrl) return cacheExternalIcon(`favicon:${exchangeId}`, faviconRawUrl);
        return null;
    });

    let errored = $state(false);
    let faviconErrored = $state(false);

    $effect(() => {
        void exchangeId;
        errored = false;
        faviconErrored = false;
    });

    function hashColor(s: string): string {
        let hash = 0;
        for (let i = 0; i < s.length; i++) {
            hash = s.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 45%, 65%)`;
    }
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
{:else if faviconUrl && !faviconErrored}
    <img
        src={faviconUrl}
        alt=""
        class="inline-block shrink-0 object-cover"
        style="width:{size}px;height:{size}px"
        loading="lazy"
        onerror={() => faviconErrored = true}
    />
{:else}
    <span
        class="rounded-full inline-flex items-center justify-center shrink-0 font-semibold text-white"
        style="width:{size}px;height:{size}px;font-size:{Math.max(size * 0.4, 8)}px;background:{hashColor(exchangeId)}"
    >
        {exchangeId.slice(0, 2).toUpperCase()}
    </span>
{/if}
