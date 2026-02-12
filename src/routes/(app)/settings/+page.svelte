<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import type { ExchangeRate } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";

  const settings = new SettingsStore();

  // Currency list from backend
  let currencies = $state<{ code: string; name: string }[]>([]);

  // Exchange rate form
  let rateFrom = $state("");
  let rateTo = $state("");
  let rateValue = $state("");
  let rateDate = $state(new Date().toISOString().slice(0, 10));

  // Exchange rates list
  let exchangeRates = $state<ExchangeRate[]>([]);
  let ratesLoading = $state(false);

  const dateFormats = [
    { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO)" },
    { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
    { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  ];

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  async function loadCurrencies() {
    try {
      currencies = await getBackend().listCurrencies();
    } catch {
      currencies = [];
    }
  }

  async function loadExchangeRates() {
    ratesLoading = true;
    try {
      exchangeRates = await getBackend().listExchangeRates();
    } catch {
      exchangeRates = [];
    } finally {
      ratesLoading = false;
    }
  }

  async function addExchangeRate() {
    if (!rateFrom.trim() || !rateTo.trim() || !rateValue.trim() || !rateDate) {
      toast.error("All fields are required");
      return;
    }
    try {
      const rate: ExchangeRate = {
        id: uuidv7(),
        date: rateDate,
        from_currency: rateFrom.toUpperCase(),
        to_currency: rateTo.toUpperCase(),
        rate: rateValue,
        source: "manual",
      };
      await getBackend().recordExchangeRate(rate);
      toast.success("Exchange rate recorded");
      rateFrom = "";
      rateTo = "";
      rateValue = "";
      rateDate = new Date().toISOString().slice(0, 10);
      await loadExchangeRates();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function handleCurrencyChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    settings.update({ currency: target.value });
  }

  function handleDateFormatChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    settings.update({ dateFormat: target.value });
  }

  function handleFiscalYearChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const month = parseInt(target.value, 10);
    const mm = String(month).padStart(2, "0");
    settings.update({ fiscalYearStart: `${mm}-01` });
  }

  onMount(() => {
    loadCurrencies();
    loadExchangeRates();
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold tracking-tight">Settings</h1>
    <p class="text-muted-foreground">Configure application preferences.</p>
  </div>

  <!-- General -->
  <Card.Root>
    <Card.Header>
      <Card.Title>General</Card.Title>
      <Card.Description>Currency, date format, and fiscal year settings.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="space-y-2">
          <label for="currency" class="text-sm font-medium">Base Currency</label>
          <select
            id="currency"
            value={settings.currency}
            onchange={handleCurrencyChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#if currencies.length === 0}
              <option value={settings.currency}>{settings.currency}</option>
            {:else}
              {#each currencies as c}
                <option value={c.code}>{c.code} - {c.name}</option>
              {/each}
            {/if}
          </select>
        </div>

        <div class="space-y-2">
          <label for="date-format" class="text-sm font-medium">Date Format</label>
          <select
            id="date-format"
            value={settings.dateFormat}
            onchange={handleDateFormatChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#each dateFormats as df}
              <option value={df.value}>{df.label}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-2">
          <label for="fiscal-year" class="text-sm font-medium">Fiscal Year Start</label>
          <select
            id="fiscal-year"
            value={parseInt(settings.fiscalYearStart.split("-")[0], 10)}
            onchange={handleFiscalYearChange}
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          >
            {#each months as m, i}
              <option value={i + 1}>{m}</option>
            {/each}
          </select>
        </div>
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Exchange Rates -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Exchange Rates</Card.Title>
      <Card.Description>Manually record exchange rates for currency conversions.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <form onsubmit={(e) => { e.preventDefault(); addExchangeRate(); }} class="flex items-end gap-3">
        <div class="space-y-1">
          <label for="rate-from" class="text-xs text-muted-foreground">From</label>
          <Input id="rate-from" bind:value={rateFrom} placeholder="BTC" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="rate-to" class="text-xs text-muted-foreground">To</label>
          <Input id="rate-to" bind:value={rateTo} placeholder="EUR" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="rate-val" class="text-xs text-muted-foreground">Rate</label>
          <Input id="rate-val" bind:value={rateValue} placeholder="45000.00" class="w-36" />
        </div>
        <div class="space-y-1">
          <label for="rate-date" class="text-xs text-muted-foreground">Date</label>
          <Input id="rate-date" type="date" bind:value={rateDate} class="w-40" />
        </div>
        <Button type="submit" size="sm">Add Rate</Button>
      </form>

      <Separator />

      {#if ratesLoading}
        <p class="text-sm text-muted-foreground">Loading exchange rates...</p>
      {:else if exchangeRates.length === 0}
        <p class="text-sm text-muted-foreground text-center py-4">No exchange rates recorded.</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Date</Table.Head>
              <Table.Head>From</Table.Head>
              <Table.Head>To</Table.Head>
              <Table.Head class="text-right">Rate</Table.Head>
              <Table.Head>Source</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each exchangeRates.slice(0, 50) as rate}
              <Table.Row>
                <Table.Cell>{rate.date}</Table.Cell>
                <Table.Cell>{rate.from_currency}</Table.Cell>
                <Table.Cell>{rate.to_currency}</Table.Cell>
                <Table.Cell class="text-right font-mono">{rate.rate}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{rate.source}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
        {#if exchangeRates.length > 50}
          <p class="text-xs text-muted-foreground text-center">Showing first 50 of {exchangeRates.length} rates.</p>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>

  <!-- Appearance -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Appearance</Card.Title>
      <Card.Description>Theme and display preferences.</Card.Description>
    </Card.Header>
    <Card.Content>
      <p class="text-sm text-muted-foreground">
        Use the theme toggle in the top bar to switch between light and dark mode.
      </p>
    </Card.Content>
  </Card.Root>
</div>
