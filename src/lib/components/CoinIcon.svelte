<script lang="ts">
    import { getCoinIconUrl, onCoinIconsChanged } from "$lib/data/coin-icons.svelte.js";

    let { code, size = 16 }: { code: string; size?: number } = $props();

    let version = $state(0);
    $effect(() => {
        return onCoinIconsChanged(() => { version++; });
    });

    const url = $derived.by(() => {
        void version; // trigger re-derivation when icons load
        return getCoinIconUrl(code);
    });

    let errored = $state(false);

    // Reset error state when code changes
    $effect(() => {
        void code;
        errored = false;
    });

    // Deterministic color from code string
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
{:else}
    <span
        class="rounded-full inline-flex items-center justify-center shrink-0 font-semibold text-white"
        style="width:{size}px;height:{size}px;font-size:{Math.max(size * 0.4, 8)}px;background:{hashColor(code)}"
    >
        {code.slice(0, 2)}
    </span>
{/if}
