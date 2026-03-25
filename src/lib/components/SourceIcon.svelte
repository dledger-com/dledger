<script lang="ts">
    import { getSourceIconUrl, parseSourceId } from "$lib/data/source-icons.js";

    let { source, size = 16 }: { source: string; size?: number } = $props();

    const parsed = $derived(parseSourceId(source));
    const iconUrl = $derived(getSourceIconUrl(source));

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
        return parsed.type;
    });
</script>

{#if iconUrl && !errored}
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
