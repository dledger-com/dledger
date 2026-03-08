<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend, type CurrencyRateSource } from "$lib/backend.js";
  import { fetchSingleRate, type SourceName } from "$lib/exchange-rate-sync.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import type { Currency, ExchangeRate } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { v7 as uuidv7 } from "uuid";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
  import { createVirtualizer } from "$lib/utils/virtual.svelte.js";
  import { setBreadcrumbOverride, clearBreadcrumbOverride } from "$lib/data/breadcrumb.svelte.js";

  const settings = new SettingsStore();
  const code = $derived(page.params.code ?? "");

  let currency = $state<Currency | null>(null);
  let rateSource = $state<CurrencyRateSource | null>(null);
  let exchangeRates = $state<ExchangeRate[]>([]);
  let loading = $state(true);

  // Chart state
  let chartData = $state<{ date: Date; value: number }[]>([]);
  let chartLoading = $state(true);
  let quoteCurrency = $state(settings.currency);
  let currencies = $state<Currency[]>([]);

  // Add rate form
  let rateFrom = $state("");
  let rateTo = $state("");
  let rateValue = $state("");
  let rateDate = $state(new Date().toISOString().slice(0, 10));

  // Sort state for rates table
  type RateSortKey = "date" | "from" | "to" | "rate" | "source";
  const sortRates = createSortState<RateSortKey>();
  const rateAccessors: Record<RateSortKey, SortAccessor<ExchangeRate>> = {
    date: (r) => r.date,
    from: (r) => r.from_currency,
    to: (r) => r.to_currency,
    rate: (r) => parseFloat(r.rate),
    source: (r) => r.source,
  };

  const sortedRates = $derived.by(() => {
    if (sortRates.key && sortRates.direction) {
      return sortItems(exchangeRates, rateAccessors[sortRates.key], sortRates.direction);
    }
    return exchangeRates;
  });

  // Virtual scrolling for rates
  let scrollEl = $state<HTMLDivElement | null>(null);

  const virtualizer = createVirtualizer(() => ({
    count: sortedRates.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 40,
    overscan: 10,
  }));

  const virtualItems = $derived(
    virtualizer.getVirtualItems().filter((row) => row.index < sortedRates.length),
  );
  const totalSize = $derived(virtualizer.getTotalSize());
  const paddingTop = $derived(virtualItems.length > 0 ? virtualItems[0].start : 0);
  const paddingBottom = $derived(
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0,
  );

  async function loadCurrencyDetail() {
    const allCurrencies = await getBackend().listCurrencies();
    currencies = allCurrencies;
    currency = allCurrencies.find((c) => c.code === code) ?? null;
  }

  async function loadRateSource() {
    try {
      const rows = await getBackend().getCurrencyRateSources();
      rateSource = rows.find((r) => r.currency === code) ?? null;
    } catch {
      rateSource = null;
    }
  }

  async function loadExchangeRates() {
    try {
      const [fromRates, toRates] = await Promise.all([
        getBackend().listExchangeRates(code, undefined),
        getBackend().listExchangeRates(undefined, code),
      ]);
      // Dedupe by id
      const seen = new Set<string>();
      const all: ExchangeRate[] = [];
      for (const r of [...fromRates, ...toRates]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          all.push(r);
        }
      }
      exchangeRates = all;
    } catch {
      exchangeRates = [];
    }
  }

  async function loadChart(currCode: string, quote: string) {
    chartLoading = true;
    try {
      if (currCode === quote) {
        chartData = [];
        chartLoading = false;
        return;
      }
      const [directRates, inverseRates] = await Promise.all([
        getBackend().listExchangeRates(currCode, quote),
        getBackend().listExchangeRates(quote, currCode),
      ]);

      // Merge: direct rates take priority, inverse rates fill gaps
      const dateMap = new Map<string, number>();
      for (const r of directRates) {
        dateMap.set(r.date, parseFloat(r.rate));
      }
      for (const r of inverseRates) {
        if (!dateMap.has(r.date)) {
          const v = parseFloat(r.rate);
          if (v !== 0) dateMap.set(r.date, 1 / v);
        }
      }

      const points = [...dateMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, value]) => ({
          date: new Date(date + "T00:00:00"),
          value: Math.round(value * 1e8) / 1e8,
        }));

      chartData = points;
    } catch (e) {
      console.error("Chart load failed:", e);
      chartData = [];
    } finally {
      chartLoading = false;
    }
  }

  async function handleSourceChange(newSource: string) {
    if (!code) return;
    await getBackend().setCurrencyRateSource(code, newSource === "auto" ? null : newSource, "user");

    if (newSource === "auto" || newSource === "none") {
      await loadRateSource();
      toast.success(`Updated ${code} rate source to ${newSource}`);
      return;
    }

    taskQueue.enqueue({
      key: `rate-refetch:${code}`,
      label: `Fetch ${code} rate from ${newSource}`,
      async run() {
        const res = await fetchSingleRate(
          getBackend(),
          code,
          newSource as SourceName,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          settings.cryptoCompareApiKey,
          settings.settings.dpriceMode,
          settings.settings.dpriceUrl,
          settings.settings.coingeckoPro,
        );
        await loadRateSource();
        await loadExchangeRates();
        if (res.success) {
          toast.success(`Fetched ${code} rate from ${newSource}`);
        } else {
          toast.error(res.error ?? `Failed to fetch ${code} rate`);
        }
        return { summary: res.success ? `${code} rate fetched` : "Failed" };
      },
    });
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
      rateFrom = code;
      rateTo = settings.currency !== code ? settings.currency : "";
      rateValue = "";
      rateDate = new Date().toISOString().slice(0, 10);
      await loadExchangeRates();
      await loadChart(code, quoteCurrency);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function reloadAll() {
    await Promise.all([
      loadCurrencyDetail(),
      loadRateSource(),
      loadExchangeRates(),
    ]);
    await loadChart(code, quoteCurrency);
  }

  const unsubCurrencies = onInvalidate("currencies", reloadAll);
  onDestroy(unsubCurrencies);

  $effect(() => {
    if (currency) {
      setBreadcrumbOverride(code, `${currency.code} — ${currency.name}`);
    }
  });

  onDestroy(() => {
    clearBreadcrumbOverride(code);
  });

  onMount(async () => {
    rateFrom = code;
    rateTo = settings.currency !== code ? settings.currency : "";
    await Promise.all([
      loadCurrencyDetail(),
      loadRateSource(),
      loadExchangeRates(),
    ]);
    loading = false;
    await loadChart(code, quoteCurrency);
  });

  // Lazy-load chart deps
  let LineChart: typeof import("layerchart").LineChart | undefined = $state();
  let scaleTime: typeof import("d3-scale").scaleTime | undefined = $state();
  let scaleLinear: typeof import("d3-scale").scaleLinear | undefined = $state();

  onMount(async () => {
    const [lc, d3] = await Promise.all([
      import("layerchart"),
      import("d3-scale"),
    ]);
    LineChart = lc.LineChart;
    scaleTime = d3.scaleTime;
    scaleLinear = d3.scaleLinear;
  });
</script>

<div class="space-y-6">
  {#if loading}
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  {:else if !currency}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">Currency not found.</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <!-- Summary row -->
    <div class="grid gap-4 sm:grid-cols-3">
      <Card.Root>
        <Card.Header>
          <Card.Description>Decimals</Card.Description>
          <Card.Title class="text-2xl">{currency.decimal_places}</Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Type</Card.Description>
          <Card.Title class="text-2xl">
            {#if currency.is_base}
              <Badge variant="default">Base</Badge>
            {:else if currency.is_hidden}
              <Badge variant="secondary">Hidden</Badge>
            {:else}
              <Badge variant="outline">Active</Badge>
            {/if}
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Rate Source</Card.Description>
          <Card.Title>
            {#if currency.is_base}
              <span class="text-muted-foreground text-sm">N/A (base currency)</span>
            {:else}
              <Select.Root type="single" value={rateSource?.rate_source ?? "auto"} onValueChange={handleSourceChange} disabled={taskQueue.isActive(`rate-refetch:${code}`)}>
                <Select.Trigger>
                  {rateSource?.rate_source ?? "auto-detect"}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="auto">auto-detect</Select.Item>
                  <Select.Item value="frankfurter">frankfurter</Select.Item>
                  <Select.Item value="defillama">defillama</Select.Item>
                  <Select.Item value="coingecko">coingecko</Select.Item>
                  <Select.Item value="cryptocompare">cryptocompare</Select.Item>
                  <Select.Item value="binance">binance</Select.Item>
                  <Select.Item value="finnhub">finnhub</Select.Item>
                  <Select.Item value="dprice">dprice</Select.Item>
                  <Select.Item value="none">none</Select.Item>
                </Select.Content>
              </Select.Root>
              {#if rateSource?.set_by}
                <span class="text-xs text-muted-foreground ml-2">{rateSource.set_by}</span>
              {/if}
            {/if}
          </Card.Title>
        </Card.Header>
      </Card.Root>
    </div>

    <!-- Price History Chart -->
    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between space-y-0">
        <div>
          <Card.Title>Price History</Card.Title>
          <Card.Description>Historical exchange rates for {code}.</Card.Description>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">Quote</span>
          <Select.Root type="single" value={quoteCurrency} onValueChange={(val) => { quoteCurrency = val; loadChart(code, val); }}>
            <Select.Trigger class="h-8" size="sm">
              {quoteCurrency}
            </Select.Trigger>
            <Select.Content>
              {#each currencies.filter((c) => c.code !== code) as c (c.code)}
                <Select.Item value={c.code}>{c.code}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </Card.Header>
      <Card.Content>
        {#if chartLoading}
          <Skeleton class="h-40 w-full" />
        {:else if chartData.length < 2}
          <p class="text-sm text-muted-foreground py-8 text-center">Not enough data for chart.</p>
        {:else if LineChart && scaleTime && scaleLinear}
          <div class="h-48">
            <LineChart
              data={chartData}
              x="date"
              xScale={scaleTime()}
              y="value"
              yScale={scaleLinear()}
              series={[{ key: "value", label: `${code}/${quoteCurrency}`, color: "hsl(var(--chart-1))" }]}
            />
          </div>
        {:else}
          <Skeleton class="h-40 w-full" />
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Add Rate Form -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Add Exchange Rate</Card.Title>
        <Card.Description>Manually record a rate for this currency.</Card.Description>
      </Card.Header>
      <Card.Content>
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
      </Card.Content>
    </Card.Root>

    <!-- Exchange Rates Table -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Exchange Rates</Card.Title>
        <Card.Description>{exchangeRates.length} rate{exchangeRates.length !== 1 ? "s" : ""} involving {code}.</Card.Description>
      </Card.Header>
      {#if exchangeRates.length === 0}
        <Card.Content>
          <p class="text-sm text-muted-foreground py-8 text-center">
            No exchange rates for this currency yet.
          </p>
        </Card.Content>
      {:else}
        <div bind:this={scrollEl} class="overflow-y-auto max-h-[calc(100vh-220px)]">
          <Table.Root>
            <Table.Header class="sticky top-0 z-10 bg-background">
              <Table.Row>
                <SortableHeader active={sortRates.key === "date"} direction={sortRates.direction} onclick={() => sortRates.toggle("date")}>Date</SortableHeader>
                <SortableHeader active={sortRates.key === "from"} direction={sortRates.direction} onclick={() => sortRates.toggle("from")}>From</SortableHeader>
                <SortableHeader active={sortRates.key === "to"} direction={sortRates.direction} onclick={() => sortRates.toggle("to")}>To</SortableHeader>
                <SortableHeader active={sortRates.key === "rate"} direction={sortRates.direction} onclick={() => sortRates.toggle("rate")} class="text-right">Rate</SortableHeader>
                <SortableHeader active={sortRates.key === "source"} direction={sortRates.direction} onclick={() => sortRates.toggle("source")}>Source</SortableHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#if paddingTop > 0}
                <tr><td style="height: {paddingTop}px;" colspan="5"></td></tr>
              {/if}
              {#each virtualItems as row (row.key)}
                {@const rate = sortedRates[row.index]}
                <Table.Row>
                  <Table.Cell class="text-muted-foreground">{rate.date}</Table.Cell>
                  <Table.Cell>{rate.from_currency}</Table.Cell>
                  <Table.Cell>{rate.to_currency}</Table.Cell>
                  <Table.Cell class="text-right font-mono">{rate.rate}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">{rate.source}</Table.Cell>
                </Table.Row>
              {/each}
              {#if paddingBottom > 0}
                <tr><td style="height: {paddingBottom}px;" colspan="5"></td></tr>
              {/if}
            </Table.Body>
          </Table.Root>
        </div>
        <div class="p-4">
          <span class="text-sm text-muted-foreground">
            {exchangeRates.length} total rate{exchangeRates.length !== 1 ? "s" : ""}
          </span>
        </div>
      {/if}
    </Card.Root>
  {/if}
</div>
