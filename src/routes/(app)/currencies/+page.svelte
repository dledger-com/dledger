<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";

  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend, type CurrencyRateSource } from "$lib/backend.js";
  import ListFilter from "$lib/components/ListFilter.svelte";
  import { matchesFilter } from "$lib/utils/list-filter.js";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems, type SortAccessor } from "$lib/utils/sort.svelte.js";
  import { getHiddenCurrencySet, markCurrencyHidden, unmarkCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import type { Currency } from "$lib/types/index.js";
  import { toast } from "svelte-sonner";
  import { fetchSingleRate, type SourceName } from "$lib/exchange-rate-sync.js";
  import { enqueueRateBackfill } from "$lib/exchange-rate-historical.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import { setTopBarActions, clearTopBarActions } from "$lib/data/page-actions.svelte.js";
  import { rateHealth } from "$lib/data/rate-health.svelte.js";
  import CircleCheck from "lucide-svelte/icons/circle-check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import Loader from "lucide-svelte/icons/loader";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import DpriceAssetDialog from "$lib/components/DpriceAssetDialog.svelte";
  import { isDpriceActive } from "$lib/data/settings.svelte.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import Plus from "lucide-svelte/icons/plus";
  import { groupDateIntervals, formatInterval } from "$lib/utils/date-intervals.js";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import * as m from "$paraglide/messages.js";

  const settings = new SettingsStore();
  const syncing = $derived(taskQueue.isActive("rate-backfill"));
  const dpriceEnabled = $derived(isDpriceActive(settings.settings.dpriceMode));

  let dpriceDialogOpen = $state(false);
  let dpriceDialogCode = $state("");
  let addDialogOpen = $state(false);

  let currencies = $state<Currency[]>([]);
  let rateSources = $state<Map<string, CurrencyRateSource>>(new Map());
  let currencySearchTerm = $state("");

  // Currency form
  let currCode = $state("");
  let currName = $state("");
  let currDecimals = $state("2");
  let currIsBase = $state(false);
  const hiddenCurrencies = $derived(currencies.filter((c) => c.is_hidden));

  // Sort state
  type CurrencySortKey = "code" | "name" | "decimals" | "base" | "rateSource";
  const sortCurr = createSortState<CurrencySortKey>();
  const currencyAccessors: Record<CurrencySortKey, SortAccessor<Currency>> = {
    code: (c) => c.code,
    name: (c) => c.name,
    decimals: (c) => c.decimal_places,
    base: (c) => c.is_base ? 1 : 0,
    rateSource: (c) => rateSources.get(c.code)?.rate_source ?? "auto",
  };

  async function loadCurrencies() {
    try {
      currencies = await getBackend().listCurrencies();
    } catch {
      currencies = [];
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
      toast.error(m.error_code_name_required());
      return;
    }
    try {
      await getBackend().createCurrency({
        code: currCode.trim().toUpperCase(),
        asset_type: "",
        param: "",
        name: currName.trim(),
        decimal_places: parseInt(currDecimals, 10) || 2,
        is_base: currIsBase,
      });
      toast.success(m.toast_currency_created({ code: currCode.trim().toUpperCase() }));
      currCode = "";
      currName = "";
      currDecimals = "2";
      currIsBase = false;
      addDialogOpen = false;
      await loadCurrencies();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSourceChange(currencyCode: string, newSource: string) {
    await getBackend().setCurrencyRateSource(currencyCode, newSource === "auto" ? null : newSource, "user");

    if (newSource === "auto" || newSource === "none") {
      await loadRateSources();
      toast.success(m.toast_rate_source_updated({ code: currencyCode, source: newSource }));
      return;
    }

    taskQueue.enqueue({
      key: `rate-refetch:${currencyCode}`,
      label: `Fetch ${currencyCode} rate from ${newSource}`,
      async run() {
        const res = await fetchSingleRate(
          getBackend(),
          currencyCode,
          newSource as SourceName,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          settings.cryptoCompareApiKey,
          settings.settings.dpriceMode,
          settings.settings.dpriceUrl,
          settings.settings.coingeckoPro,
        );
        await loadRateSources();
        if (res.success) {
          toast.success(m.toast_rate_fetched({ code: currencyCode, source: newSource }));
        } else {
          toast.error(res.error ?? `Failed to fetch ${currencyCode} rate`);
        }
        return { summary: res.success ? `${currencyCode} rate fetched` : "Failed" };
      },
    });
  }

  async function handleDontConvert(code: string) {
    await getBackend().setCurrencyRateSource(code, "none", "user");
    await loadRateSources();
    toast.success(m.toast_rate_source_updated({ code, source: "none" }));
  }

  function syncRates() {
    enqueueRateBackfill(taskQueue, getBackend(), settings.buildRateConfig(), getHiddenCurrencySet());
  }

  const unsubCurrencies = onInvalidate("currencies", () => {
    loadCurrencies();
    loadRateSources();
  });
  onDestroy(() => { unsubCurrencies(); clearTopBarActions(); });

  $effect(() => {
    setTopBarActions([
      { type: "button", label: m.btn_add(), onclick: () => { addDialogOpen = true; }, fab: true, fabIcon: Plus },
    ]);
  });

  onMount(() => {
    loadCurrencies();
    loadRateSources();
  });
</script>

<div class="space-y-6">
  <!-- Rate health banner -->
  {#if rateHealth.status === "syncing" || syncing}
    <div class="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
      <Loader class="h-4 w-4 animate-spin" />
      <span>{m.banner_syncing_rates()}</span>
    </div>
  {:else if rateHealth.status === "missing" && rateHealth.missingCurrencies.length > 0}
    <div class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950">
      <div class="flex items-start gap-2">
        <CircleAlert class="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <div class="space-y-2 w-full">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium text-amber-800 dark:text-amber-200">
              {m.banner_missing_rates({ count: String(rateHealth.missingCurrencies.length) })}
            </p>
            <Button size="sm" variant="outline" onclick={syncRates} disabled={syncing}>
              {m.btn_sync_rates()}
            </Button>
          </div>
          <div class="space-y-2">
            {#each rateHealth.missingCurrencies as code}
              {@const dates = rateHealth.missingDatesByCode[code]}
              {@const intervals = dates ? groupDateIntervals(dates) : []}
              <Collapsible.Root>
                <div class="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs dark:border-amber-700 dark:bg-amber-900">
                  <Collapsible.Trigger class="inline-flex items-center gap-1 font-mono font-medium text-amber-800 hover:underline dark:text-amber-200 cursor-pointer">
                    {code}
                    {#if intervals.length > 0}
                      <ChevronDown class="h-3 w-3" />
                    {/if}
                  </Collapsible.Trigger>
                  <span class="text-amber-400 dark:text-amber-600">|</span>
                  <button
                    onclick={async () => { await markCurrencyHidden(getBackend(), code); await loadCurrencies(); }}
                    class="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 cursor-pointer"
                  >{m.btn_hide()}</button>
                  <span class="text-amber-400 dark:text-amber-600">|</span>
                  <a href="/currencies/{code}" class="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200">{m.btn_enter_rate()}</a>
                  <span class="text-amber-400 dark:text-amber-600">|</span>
                  <button
                    onclick={() => handleDontConvert(code)}
                    class="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 cursor-pointer"
                  >{m.btn_dont_convert()}</button>
                  {#if dpriceEnabled}
                    <span class="text-amber-400 dark:text-amber-600">|</span>
                    <button
                      onclick={() => { dpriceDialogCode = code; dpriceDialogOpen = true; }}
                      class="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 cursor-pointer"
                    >{m.btn_link_dprice()}</button>
                  {/if}
                </div>
                {#if intervals.length > 0}
                  <Collapsible.Content>
                    <div class="ml-2 mt-1 flex flex-wrap gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                      {#each intervals as iv}
                        <span class="rounded bg-amber-100 px-1.5 py-0.5 font-mono dark:bg-amber-900/50">{formatInterval(iv)}</span>
                      {/each}
                      <span class="text-amber-500 dark:text-amber-500">({dates.length} {dates.length === 1 ? "date" : "dates"})</span>
                    </div>
                  </Collapsible.Content>
                {/if}
              </Collapsible.Root>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {:else if rateHealth.status === "ok"}
    <div class="flex items-center justify-between rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
      <div class="flex items-center gap-2">
        <CircleCheck class="h-4 w-4" />
        <span>{m.banner_rates_ok()}</span>
      </div>
      <Button size="sm" variant="ghost" onclick={syncRates} disabled={syncing}>
        {m.btn_sync_rates()}
      </Button>
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3">
    <ListFilter bind:value={currencySearchTerm} placeholder={m.placeholder_filter_currencies()} class="order-last sm:order-none" />
    <div class="flex flex-wrap items-center gap-3 shrink-0">
      <label class="flex items-center gap-2 text-sm">
        <Switch
          checked={settings.showHidden}
          onCheckedChange={(v) => settings.update({ showHidden: v })}
        />
        {m.label_show_hidden()}
      </label>
    </div>
  </div>

  <Dialog.Root bind:open={addDialogOpen}>
    <Dialog.Content class="max-w-sm">
      <Dialog.Header>
        <Dialog.Title>{m.btn_add()}</Dialog.Title>
      </Dialog.Header>
      <form onsubmit={(e) => { e.preventDefault(); addCurrency(); }} class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="curr-code" class="text-xs text-muted-foreground">{m.label_code()}</label>
            <Input id="curr-code" bind:value={currCode} placeholder="EUR" />
          </div>
          <div class="space-y-1">
            <label for="curr-name" class="text-xs text-muted-foreground">{m.label_name()}</label>
            <Input id="curr-name" bind:value={currName} placeholder="Euro" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="curr-decimals" class="text-xs text-muted-foreground">{m.label_decimals()}</label>
            <Input id="curr-decimals" type="number" bind:value={currDecimals} />
          </div>
          <div class="flex items-center gap-2 pt-5">
            <Switch id="curr-base" bind:checked={currIsBase} />
            <label for="curr-base" class="text-xs text-muted-foreground">{m.label_base()}</label>
          </div>
        </div>
        <Dialog.Footer>
          <Button type="submit" size="sm">{m.btn_add()}</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>

  {#if currencies.length === 0}
    <Card.Root class="border-x-0 rounded-none shadow-none">
      <Card.Content class="py-8">
        <p class="text-sm text-muted-foreground text-center">{m.empty_no_currencies()}</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root class="border-x-0 rounded-none shadow-none py-0">
      <Card.Content class="p-0">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <SortableHeader active={sortCurr.key === "code"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("code")}>{m.label_code()}</SortableHeader>
              <SortableHeader active={sortCurr.key === "name"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("name")}>{m.label_name()}</SortableHeader>
              <SortableHeader active={sortCurr.key === "decimals"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("decimals")} class="text-right hidden md:table-cell">{m.label_decimals()}</SortableHeader>
              <SortableHeader active={sortCurr.key === "base"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("base")} class="hidden sm:table-cell">{m.label_base()}</SortableHeader>
              <SortableHeader active={sortCurr.key === "rateSource"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("rateSource")} class="hidden lg:table-cell">{m.label_rate_source()}</SortableHeader>
              <Table.Head class="text-right">{m.label_actions()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const filteredCurrencies = currencies.filter((c) => (!c.is_hidden || settings.showHidden) && matchesFilter(c, currencySearchTerm.trim(), ["code", "name"]))}
            {@const sortedCurrencies = sortCurr.key && sortCurr.direction ? sortItems(filteredCurrencies, currencyAccessors[sortCurr.key], sortCurr.direction) : filteredCurrencies}
            {#each sortedCurrencies as c}
              {@const rs = rateSources.get(c.code)}
              <Table.Row>
                <Table.Cell class="font-mono">
                  <a href="/currencies/{c.code}" class="hover:underline text-primary">
                    {c.code}
                  </a>
                  {#if c.is_hidden}
                    <span class="ml-1 text-xs text-muted-foreground">{m.label_hidden()}</span>
                  {/if}
                </Table.Cell>
                <Table.Cell>{c.name}</Table.Cell>
                <Table.Cell class="text-right hidden md:table-cell">{c.decimal_places}</Table.Cell>
                <Table.Cell class="hidden sm:table-cell">
                  {#if c.is_base}
                    <span class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{m.label_base()}</span>
                  {/if}
                </Table.Cell>
                <Table.Cell class="hidden lg:table-cell">
                  {#if !c.is_base}
                    <div class="flex items-center gap-2">
                      <Select.Root type="single" value={rs?.rate_source ?? "auto"} onValueChange={(val) => handleSourceChange(c.code, val)} disabled={taskQueue.isActive(`rate-refetch:${c.code}`)}>
                        <Select.Trigger class="h-7" size="sm">
                          {rs?.rate_source ?? m.label_auto_detect()}
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
                      {#if rs?.set_by}
                        <span class="text-xs text-muted-foreground">{rs.set_by}</span>
                      {/if}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-right">
                  {#if !c.is_base}
                    {#if c.is_hidden}
                      <Button variant="ghost" size="sm" onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_unhide()}</Button>
                    {:else}
                      <Button variant="ghost" size="sm" onclick={async () => { await markCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_hide()}</Button>
                    {/if}
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if hiddenCurrencies.length > 0 && !settings.showHidden}
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium">{m.section_hidden_currencies({ count: String(hiddenCurrencies.length) })}</h3>
        <Button variant="outline" size="sm" onclick={async () => {
          for (const c of hiddenCurrencies) {
            await unmarkCurrencyHidden(getBackend(), c.code);
          }
          await loadCurrencies();
        }}>{m.btn_unhide_all()}</Button>
      </div>
      <Card.Root class="border-x-0 rounded-none shadow-none py-0">
        <Card.Content class="p-0">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>{m.label_code()}</Table.Head>
                <Table.Head>{m.label_name()}</Table.Head>
                <Table.Head class="text-right">{m.label_actions()}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each hiddenCurrencies as c}
                <Table.Row>
                  <Table.Cell class="font-mono">
                    <a href="/currencies/{c.code}" class="hover:underline text-primary">{c.code}</a>
                  </Table.Cell>
                  <Table.Cell>{c.name}</Table.Cell>
                  <Table.Cell class="text-right">
                    <Button variant="ghost" size="sm" onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_unhide()}</Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </Card.Content>
      </Card.Root>
    </div>
  {/if}
</div>

{#if dpriceEnabled}
  <DpriceAssetDialog currencyCode={dpriceDialogCode} bind:open={dpriceDialogOpen} />
{/if}
