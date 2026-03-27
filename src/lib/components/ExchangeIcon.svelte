<script lang="ts">
    import { getExchangeIconUrl } from "$lib/data/exchange-icons.js";
    import { cacheExternalIcon, onCoinIconsChanged } from "$lib/data/coin-icons.svelte.js";

    let { exchangeId, size = 16 }: { exchangeId: string; size?: number } = $props();

    const rawUrl = $derived(getExchangeIconUrl(exchangeId));

    // Subscribe to icon cache updates for reactivity
    let _tick = $state(0);
    $effect(() => onCoinIconsChanged(() => _tick++));

    const url = $derived.by(() => {
        void _tick;
        if (rawUrl) return cacheExternalIcon(`exchange:${exchangeId}`, rawUrl);
        return null;
    });

    let errored = $state(false);

    $effect(() => {
        void exchangeId;
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
</script>

{#if url && !errored}
    <img
        src={url}
        alt=""
        class="inline-block shrink-0 object-cover"
        style="width:{size}px;height:{size}px"
        loading="lazy"
        onerror={() => errored = true}
    />
{:else}
    <span
        class="rounded-full inline-flex items-center justify-center shrink-0 font-semibold text-white"
        style="width:{size}px;height:{size}px;font-size:{Math.max(size * 0.4, 8)}px;background:{hashColor(exchangeId)}"
    >
        {exchangeId.slice(0, 2).toUpperCase()}
    </span>
{/if}
