<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend, type CurrencyRateSource } from "$lib/backend.js";
  import type { Currency, ExchangeRate } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import { fetchSingleRate, type SourceName } from "$lib/exchange-rate-sync.js";
  const settings = new SettingsStore();

  // Currency list from backend
  let currencies = $state<Currency[]>([]);

  // Rate source config from DB
  let rateSources = $state<Map<string, CurrencyRateSource>>(new Map());

  // Currency form
  let currCode = $state("");
  let currName = $state("");
  let currDecimals = $state("2");
  let currIsBase = $state(false);

  // Exchange rate form
  let rateFrom = $state("");
  let rateTo = $state("");
  let rateValue = $state("");
  let rateDate = $state(new Date().toISOString().slice(0, 10));

  // Exchange rates list
  let exchangeRates = $state<ExchangeRate[]>([]);
  let ratesLoading = $state(false);
  let refetchingCurrency = $state<string | null>(null);

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

  async function loadRateSources() {
    try {
      const rows = await getBackend().getCurrencyRateSources();
      rateSources = new Map(rows.map((r) => [r.currency, r]));
    } catch {
      rateSources = new Map();
    }
  }

  async function addCurrency() {
    if (!currCode.trim() || !currName.trim()) {
      toast.error("Code and name are required");
      return;
    }
    try {
      await getBackend().createCurrency({
        code: currCode.trim().toUpperCase(),
        name: currName.trim(),
        decimal_places: parseInt(currDecimals, 10) || 2,
        is_base: currIsBase,
      });
      toast.success(`Currency ${currCode.trim().toUpperCase()} created`);
      currCode = "";
      currName = "";
      currDecimals = "2";
      currIsBase = false;
      await loadCurrencies();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
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

  async function handleClearExchangeRates() {
    if (!window.confirm("Are you sure you want to clear all exchange rates? This cannot be undone.")) return;
    try {
      await getBackend().clearExchangeRates();
      await getBackend().clearAutoRateSources();
      await loadExchangeRates();
      toast.success("Exchange rates cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearLedgerData() {
    if (!window.confirm("Are you sure you want to clear all ledger data? This will remove all accounts, transactions, and currencies. Exchange rates, sources, and settings will be preserved. This cannot be undone.")) return;
    try {
      await getBackend().clearLedgerData();
      settings.resetHiddenCurrencies();
      currencies = [];
      toast.success("Ledger data cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearAllData() {
    if (!window.confirm("Are you sure you want to delete ALL data? This will remove all accounts, transactions, currencies, exchange rates, and reset settings. This cannot be undone.")) return;
    try {
      await getBackend().clearAllData();
      settings.reset();
      currencies = [];
      exchangeRates = [];
      toast.success("All data cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSourceChange(currencyCode: string, newSource: string) {
    // Save to DB as user preference
    await getBackend().setCurrencyRateSource(currencyCode, newSource === "auto" ? null : newSource, "user");

    if (newSource === "auto" || newSource === "none") {
      await loadRateSources();
      toast.success(`Updated ${currencyCode} rate source to ${newSource}`);
      return;
    }

    // Refetch rate from new source
    refetchingCurrency = currencyCode;
    try {
      const res = await fetchSingleRate(
        getBackend(),
        currencyCode,
        newSource as SourceName,
        settings.currency,
        settings.coingeckoApiKey,
        settings.finnhubApiKey,
      );
      if (res.success) {
        await loadExchangeRates();
        toast.success(`Fetched ${currencyCode} rate from ${newSource}`);
      } else {
        toast.error(res.error ?? `Failed to fetch ${currencyCode} rate`);
      }
    } catch (err) {
      toast.error(`Failed to refetch rate: ${err}`);
    } finally {
      refetchingCurrency = null;
      await loadRateSources();
    }
  }

  onMount(() => {
    loadCurrencies();
    loadExchangeRates();
    loadRateSources();
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

  <!-- Currencies -->
  <Card.Root>
    <Card.Header>
      <div class="flex items-center justify-between">
        <div>
          <Card.Title>Currencies</Card.Title>
          <Card.Description>Add currencies and manage rate sources.</Card.Description>
        </div>
        <Button
          variant="outline"
          size="sm"
          onclick={async () => {
            await getBackend().clearAutoRateSources();
            await loadRateSources();
            toast.success("Auto-detected rate sources cleared. They will be re-detected on next sync.");
          }}
        >
          Re-detect Sources
        </Button>
      </div>
    </Card.Header>
    <Card.Content class="space-y-4">
      <form onsubmit={(e) => { e.preventDefault(); addCurrency(); }} class="flex items-end gap-3">
        <div class="space-y-1">
          <label for="curr-code" class="text-xs text-muted-foreground">Code</label>
          <Input id="curr-code" bind:value={currCode} placeholder="EUR" class="w-24" />
        </div>
        <div class="space-y-1">
          <label for="curr-name" class="text-xs text-muted-foreground">Name</label>
          <Input id="curr-name" bind:value={currName} placeholder="Euro" class="w-40" />
        </div>
        <div class="space-y-1">
          <label for="curr-decimals" class="text-xs text-muted-foreground">Decimals</label>
          <Input id="curr-decimals" type="number" bind:value={currDecimals} class="w-20" />
        </div>
        <div class="space-y-1 flex items-center gap-2 pb-1">
          <input id="curr-base" type="checkbox" bind:checked={currIsBase} class="h-4 w-4 rounded border-input" />
          <label for="curr-base" class="text-xs text-muted-foreground">Base</label>
        </div>
        <Button type="submit" size="sm">Add</Button>
      </form>

      <Separator />

      {#if currencies.length === 0}
        <p class="text-sm text-muted-foreground text-center py-4">No currencies defined.</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Code</Table.Head>
              <Table.Head>Name</Table.Head>
              <Table.Head class="text-right">Decimals</Table.Head>
              <Table.Head>Base</Table.Head>
              <Table.Head>Rate Source</Table.Head>
              <Table.Head class="text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each currencies.filter((c) => !settings.hiddenCurrencySet.has(c.code)) as c}
              {@const rs = rateSources.get(c.code)}
              <Table.Row>
                <Table.Cell class="font-mono">{c.code}</Table.Cell>
                <Table.Cell>{c.name}</Table.Cell>
                <Table.Cell class="text-right">{c.decimal_places}</Table.Cell>
                <Table.Cell>
                  {#if c.is_base}
                    <span class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Base</span>
                  {/if}
                </Table.Cell>
                <Table.Cell>
                  {#if !c.is_base}
                    <div class="flex items-center gap-2">
                      <select
                        value={rs?.rate_source ?? "auto"}
                        onchange={(e) => {
                          const val = (e.target as HTMLSelectElement).value;
                          handleSourceChange(c.code, val);
                        }}
                        disabled={refetchingCurrency === c.code}
                        class="flex h-7 rounded-md border border-input bg-transparent px-2 py-0.5 text-sm disabled:opacity-50"
                      >
                        <option value="auto">auto-detect</option>
                        <option value="frankfurter">frankfurter</option>
                        <option value="coingecko">coingecko</option>
                        <option value="finnhub">finnhub</option>
                        <option value="none">none</option>
                      </select>
                      {#if rs?.set_by}
                        <span class="text-xs text-muted-foreground">{rs.set_by}</span>
                      {/if}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-right">
                  {#if !c.is_base}
                    <Button variant="ghost" size="sm" onclick={() => settings.hideCurrency(c.code)}>Hide</Button>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}

      {#if settings.settings.hiddenCurrencies.length > 0}
        <Separator />
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium">Hidden Currencies ({settings.settings.hiddenCurrencies.length})</h3>
            <Button variant="outline" size="sm" onclick={() => settings.resetHiddenCurrencies()}>Reset All</Button>
          </div>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Code</Table.Head>
                <Table.Head>Name</Table.Head>
                <Table.Head class="text-right">Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each settings.settings.hiddenCurrencies as code}
                {@const curr = currencies.find((c) => c.code === code)}
                <Table.Row>
                  <Table.Cell class="font-mono">{code}</Table.Cell>
                  <Table.Cell>{curr?.name ?? ""}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Button variant="ghost" size="sm" onclick={() => settings.unhideCurrency(code)}>Unhide</Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
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

  <!-- Data Management -->
  <Card.Root>
    <Card.Header>
      <Card.Title>Data Management</Card.Title>
      <Card.Description>Clear stored data. These actions cannot be undone.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear Exchange Rates</p>
          <p class="text-sm text-muted-foreground">Remove all synced and manual exchange rates.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearExchangeRates}>Clear Rates</Button>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear Ledger Data</p>
          <p class="text-sm text-muted-foreground">Remove all accounts, transactions, and currencies. Exchange rates, sources, and settings are preserved.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearLedgerData}>Clear Ledger</Button>
      </div>
      <Separator />
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Clear All Data</p>
          <p class="text-sm text-muted-foreground">Delete all accounts, transactions, currencies, exchange rates, and reset settings.</p>
        </div>
        <Button variant="destructive" size="sm" onclick={handleClearAllData}>Clear All Data</Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if import.meta.env.DEV}
    <Card.Root>
      <Card.Header>
        <Card.Title>Development</Card.Title>
        <Card.Description>Debug tools (only visible in dev mode).</Card.Description>
      </Card.Header>
      <Card.Content>
        <Button
          variant={settings.debugMode ? "default" : "outline"}
          onclick={() => settings.update({ debugMode: !settings.debugMode })}
        >
          {settings.debugMode ? "Debug Mode: ON" : "Debug Mode: OFF"}
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
