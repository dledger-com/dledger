<script lang="ts">
    import { getSourceIconUrl, parseSourceId, getProtocolToken, getDescriptionChainIcon, getSourceNativeCurrency, isL2Chain } from "$lib/data/source-icons.js";
    import CoinIcon from "$lib/components/CoinIcon.svelte";
    import { cacheExternalIcon, onCoinIconsChanged, getCoinIconUrl } from "$lib/data/coin-icons.svelte.js";

    let { source, descriptionData, size = 16 }: { source: string; descriptionData?: string; size?: number } = $props();

    const parsed = $derived(parseSourceId(source));
    const rawIconUrl = $derived(getSourceIconUrl(source));

    // Subscribe to icon cache updates for reactivity
    let _tick = $state(0);
    $effect(() => onCoinIconsChanged(() => _tick++));

    // Chain icon from descriptionData takes priority (for CSV imports with chain context)
    const descChainIconUrl = $derived(getDescriptionChainIcon(descriptionData));

    const iconUrl = $derived.by(() => {
        void _tick;
        const url = descChainIconUrl ?? rawIconUrl;
        if (!url) return null;
        const cacheKey = descChainIconUrl
            ? `desc-chain:${descriptionData?.slice(0, 40)}`
            : `source:${source.slice(0, 40)}`;
        return cacheExternalIcon(cacheKey, url);
    });

    // Priority: protocol token (if icon available) → L2 chain icon → L1/non-EVM native currency CoinIcon → fallback
    const coinCode = $derived.by(() => {
        void _tick; // re-derive when icons load
        // 1. Protocol token (from description_data) — only if icon is cached
        const proto = getProtocolToken(descriptionData);
        if (proto && getCoinIconUrl(proto)) return proto;

        // 2. EVM L2 → null (fall through to chain icon via iconUrl)
        if ((parsed.type === "etherscan" || parsed.type === "thegraph") && parsed.chainId) {
            if (isL2Chain(parsed.chainId)) return null;
        }

        // 3. L1 / non-EVM chain → native currency CoinIcon
        return getSourceNativeCurrency(parsed);
    });

    let errored = $state(false);
    $effect(() => { void source; errored = false; });

    function hashColor(s: string): string {
        let hash = 0;
        for (let i = 0; i < s.length; i++) {
            hash = s.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 45%, 65%)`;
    }

    const label = $derived.by(() => {
        if (parsed.institutionId) return parsed.institutionId;
        if (parsed.chainName) return parsed.chainName;
        return parsed.type;
    });
</script>

{#if coinCode}
    <CoinIcon code={coinCode} {size} />
{:else if iconUrl && !errored}
    <img
        src={iconUrl}
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
        {label.slice(0, 2).toUpperCase()}
    </span>
{/if}
