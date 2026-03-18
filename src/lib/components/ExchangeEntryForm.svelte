<script lang="ts">
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import AccountCombobox from "$lib/components/AccountCombobox.svelte";
  import type { Currency } from "$lib/types/account.js";
  import ArrowDown from "lucide-svelte/icons/arrow-down";

  let {
    currencies,
    accountNames,
    fromCurrency = $bindable("EUR"),
    toCurrency = $bindable("BTC"),
    fromAmount = $bindable(""),
    toAmount = $bindable(""),
    fromAccount = $bindable(""),
    toAccount = $bindable(""),
  }: {
    currencies: Currency[];
    accountNames: string[];
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    toAmount: string;
    fromAccount: string;
    toAccount: string;
  } = $props();

  const impliedRate = $derived.by(() => {
    const from = parseFloat(fromAmount);
    const to = parseFloat(toAmount);
    if (!from || !to || from <= 0 || to <= 0) return null;
    const rate = from / to;
    return `1 ${toCurrency} = ${rate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${fromCurrency}`;
  });
</script>

<div class="space-y-4">
  <div class="space-y-2">
    <span class="text-sm font-medium text-muted-foreground">From (spent)</span>
    <div class="grid grid-cols-[120px_1fr_1fr] gap-2 items-center">
      <Select.Root type="single" bind:value={fromCurrency}>
        <Select.Trigger class="w-full">
          {fromCurrency}
        </Select.Trigger>
        <Select.Content>
          {#each currencies as c (c.code)}
            <Select.Item value={c.code}>{c.code} - {c.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Input
        type="number"
        step="any"
        min="0"
        placeholder="Amount"
        bind:value={fromAmount}
        class="font-mono"
      />
      <AccountCombobox
        value={fromAccount}
        accounts={accountNames}
        variant="input"
        placeholder="From account..."
        onchange={(v) => { fromAccount = v; }}
      />
    </div>
  </div>

  <div class="flex justify-center">
    <ArrowDown class="h-4 w-4 text-muted-foreground" />
  </div>

  <div class="space-y-2">
    <span class="text-sm font-medium text-muted-foreground">To (received)</span>
    <div class="grid grid-cols-[120px_1fr_1fr] gap-2 items-center">
      <Select.Root type="single" bind:value={toCurrency}>
        <Select.Trigger class="w-full">
          {toCurrency}
        </Select.Trigger>
        <Select.Content>
          {#each currencies as c (c.code)}
            <Select.Item value={c.code}>{c.code} - {c.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Input
        type="number"
        step="any"
        min="0"
        placeholder="Amount"
        bind:value={toAmount}
        class="font-mono"
      />
      <AccountCombobox
        value={toAccount}
        accounts={accountNames}
        variant="input"
        placeholder="To account..."
        onchange={(v) => { toAccount = v; }}
      />
    </div>
  </div>

  {#if impliedRate}
    <p class="text-sm text-muted-foreground text-center">{impliedRate}</p>
  {/if}
</div>
