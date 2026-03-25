<script lang="ts">
    import CoinIcon from "./CoinIcon.svelte";
    import { formatAmountOnly } from "$lib/utils/format.js";

    let { amount, currency, size = 14, showIcon = true }: {
        amount: string;
        currency: string;
        size?: number;
        showIcon?: boolean;
    } = $props();
</script>

<span class="inline-flex items-center gap-0.5">
    {#if showIcon}<CoinIcon code={currency} {size} />{/if}
    {formatAmountOnly(amount)} {currency}
</span>
