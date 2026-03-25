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
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import SlidersHorizontal from "lucide-svelte/icons/sliders-horizontal";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import Filter from "lucide-svelte/icons/filter";
  import { inferAssetType } from "$lib/currency-type.js";
  import DpriceAssetDialog from "$lib/components/DpriceAssetDialog.svelte";
  import { isDpriceActive } from "$lib/data/settings.svelte.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { goto } from "$app/navigation";
  import Plus from "lucide-svelte/icons/plus";
  import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
  import { groupDateIntervals, formatInterval } from "$lib/utils/date-intervals.js";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import * as m from "$paraglide/messages.js";

  const settings = new SettingsStore();
  const syncing = $derived(taskQueue.isActive("rate-backfill"));
  const dpriceEnabled = $derived(isDpriceActive(settings.settings.dpriceMode));

  let dpriceDialogOpen = $state(false);
  let dpriceDialogCode = $state("");
  let addDialogOpen = $state(false);
  let renamingCode = $state("");
  let renameValue = $state("");

  let currencies = $state<Currency[]>([]);
  let rateSources = $state<Map<string, CurrencyRateSource>>(new Map());
  let currencySearchTerm = $state("");
  let selectedAssetTypes = $state(new Set<string>());
  let holdings = $state(new Map<string, number>());
  let lastPrices = $state(new Map<string, number>());
  let colVis = $state<Record<string, boolean>>(settings.settings.currencyColumnVisibility ?? {});

  const ASSET_TYPES: { value: string; label: () => string }[] = [
    { value: "", label: () => m.asset_type_unclassified() },
    { value: "fiat", label: () => m.asset_type_fiat() },
    { value: "crypto", label: () => m.asset_type_crypto() },
    { value: "stock", label: () => m.asset_type_stock() },
    { value: "commodity", label: () => m.asset_type_commodity() },
    { value: "index", label: () => m.asset_type_index() },
    { value: "bond", label: () => m.asset_type_bond() },
  ];

  /** Infer asset type dynamically: stored value → static heuristic → dprice source ID */
  function effectiveAssetType(c: Currency): string {
    if (c.asset_type) return c.asset_type;
    const inferred = inferAssetType(c.code);
    if (inferred) return inferred;
    const rs = rateSources.get(c.code);
    if (rs?.rate_source_id?.startsWith("crypto:")) return "crypto";
    if (rs?.rate_source_id?.startsWith("fiat:")) return "fiat";
    return "";
  }

  // Currency form
  let currCode = $state("");
  let currName = $state("");
  let currDecimals = $state("2");
  let currIsBase = $state(false);
  const hiddenCurrencies = $derived(currencies.filter((c) => c.is_hidden));

  // Sort state
  type CurrencySortKey = "code" | "name" | "type" | "lastPrice" | "holdings" | "value" | "decimals" | "base" | "rateSource";
  const sortCurr = createSortState<CurrencySortKey>();
  const currencyAccessors: Record<CurrencySortKey, SortAccessor<Currency>> = {
    code: (c) => c.code,
    name: (c) => c.name,
    type: (c) => effectiveAssetType(c),
    lastPrice: (c) => lastPrices.get(c.code) ?? 0,
    holdings: (c) => holdings.get(c.code) ?? 0,
    value: (c) => (holdings.get(c.code) ?? 0) * (c.is_base ? 1 : (lastPrices.get(c.code) ?? 0)),
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

  async function loadMarketData() {
    const backend = getBackend();
    const baseCurrency = settings.currency;
    const today = new Date().toISOString().slice(0, 10);
    try {
      // Holdings: sum across all asset + liability accounts
      const sheet = await backend.balanceSheet(today);
      const h = new Map<string, number>();
      for (const b of sheet.assets.totals) {
        h.set(b.currency, (h.get(b.currency) ?? 0) + parseFloat(b.amount));
      }
      for (const b of sheet.liabilities.totals) {
        h.set(b.currency, (h.get(b.currency) ?? 0) + parseFloat(b.amount));
      }
      holdings = h;

      // Last prices: for each non-base currency, get latest rate
      const prices = new Map<string, number>();
      for (const code of h.keys()) {
        if (code === baseCurrency) continue;
        const rate = await backend.getExchangeRate(code, baseCurrency, today);
        if (rate) prices.set(code, parseFloat(rate));
      }
      lastPrices = prices;
    } catch (e) {
      console.error("loadMarketData failed:", e);
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

  function startRename(code: string, currentName: string) {
    renamingCode = code;
    renameValue = currentName;
  }

  async function commitRename() {
    if (!renamingCode || !renameValue.trim()) { renamingCode = ""; return; }
    try {
      await getBackend().setCurrencyName(renamingCode, renameValue.trim());
      await loadCurrencies();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    renamingCode = "";
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
    loadMarketData();
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

  <div class="flex items-center gap-2">
    <ListFilter bind:value={currencySearchTerm} placeholder={m.placeholder_filter_currencies()} class="min-w-0 w-[200px] lg:w-[250px] shrink" />
    <Popover.Root>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button variant="outline" size="sm" class="h-8 border-dashed" {...props}>
            <Filter class="size-4" />
            <span class="hidden sm:inline">{m.label_filter()}</span>
            {#if selectedAssetTypes.size > 0}
              <Separator orientation="vertical" class="mx-1 h-4" />
              <Badge variant="secondary" class="rounded-sm px-1 font-normal">
                {selectedAssetTypes.size}
              </Badge>
            {/if}
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content class="w-[200px] p-2" align="start">
        <div class="space-y-1">
          {#each ASSET_TYPES as at}
            <label class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer">
              <Checkbox
                checked={selectedAssetTypes.has(at.value)}
                onCheckedChange={(v) => {
                  const next = new Set(selectedAssetTypes);
                  if (v) next.add(at.value); else next.delete(at.value);
                  selectedAssetTypes = next;
                }}
              />
              {at.label()}
            </label>
          {/each}
        </div>
        {#if selectedAssetTypes.size > 0}
          <Separator class="my-1" />
          <button
            class="w-full rounded-sm px-2 py-1.5 text-sm text-center hover:bg-accent cursor-pointer"
            onclick={() => { selectedAssetTypes = new Set(); }}
          >{m.btn_clear()}</button>
        {/if}
      </Popover.Content>
    </Popover.Root>
    <div class="ml-auto">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button variant="outline" size="sm" class="h-8" {...props}>
              <SlidersHorizontal class="size-4" />
              <span class="hidden sm:inline">{m.label_view()}</span>
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[170px]">
          <DropdownMenu.CheckboxItem
            checked={settings.showHidden}
            onCheckedChange={(v) => settings.update({ showHidden: !!v })}
          >{m.label_show_hidden()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator />
          <DropdownMenu.Item disabled class="text-xs font-medium opacity-70">{m.label_columns()}</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={colVis.type !== false}
            onCheckedChange={(v) => { colVis = { ...colVis, type: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_type()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.lastPrice !== false}
            onCheckedChange={(v) => { colVis = { ...colVis, lastPrice: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_last_price()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.holdings === true}
            onCheckedChange={(v) => { colVis = { ...colVis, holdings: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_holdings()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.value !== false}
            onCheckedChange={(v) => { colVis = { ...colVis, value: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_value()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.decimals !== false}
            onCheckedChange={(v) => { colVis = { ...colVis, decimals: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_decimals()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.base !== false}
            onCheckedChange={(v) => { colVis = { ...colVis, base: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_base()}</DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={colVis.rateSource === true}
            onCheckedChange={(v) => { colVis = { ...colVis, rateSource: !!v }; settings.update({ currencyColumnVisibility: colVis }); }}
          >{m.label_rate_source()}</DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
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
              {#if colVis.type !== false}<SortableHeader active={sortCurr.key === "type"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("type")} class="hidden sm:table-cell">{m.label_type()}</SortableHeader>{/if}
              {#if colVis.lastPrice !== false}<SortableHeader active={sortCurr.key === "lastPrice"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("lastPrice")} class="text-right hidden md:table-cell">{m.label_last_price()}</SortableHeader>{/if}
              {#if colVis.holdings === true}<SortableHeader active={sortCurr.key === "holdings"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("holdings")} class="text-right hidden md:table-cell">{m.label_holdings()}</SortableHeader>{/if}
              {#if colVis.value !== false}<SortableHeader active={sortCurr.key === "value"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("value")} class="text-right hidden md:table-cell">{m.label_value()}</SortableHeader>{/if}
              {#if colVis.decimals !== false}<SortableHeader active={sortCurr.key === "decimals"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("decimals")} class="text-right hidden lg:table-cell">{m.label_decimals()}</SortableHeader>{/if}
              {#if colVis.base !== false}<SortableHeader active={sortCurr.key === "base"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("base")} class="hidden lg:table-cell">{m.label_base()}</SortableHeader>{/if}
              {#if colVis.rateSource === true}<SortableHeader active={sortCurr.key === "rateSource"} direction={sortCurr.direction} onclick={() => sortCurr.toggle("rateSource")} class="hidden xl:table-cell">{m.label_rate_source()}</SortableHeader>{/if}
              <Table.Head class="text-right">{m.label_actions()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {@const filteredCurrencies = currencies.filter((c) => (!c.is_hidden || settings.showHidden) && matchesFilter(c, currencySearchTerm.trim(), ["code", "name"]) && (selectedAssetTypes.size === 0 || selectedAssetTypes.has(effectiveAssetType(c))))}
            {@const sortedCurrencies = sortCurr.key && sortCurr.direction ? sortItems(filteredCurrencies, currencyAccessors[sortCurr.key], sortCurr.direction) : filteredCurrencies}
            {#each sortedCurrencies as c}
              {@const rs = rateSources.get(c.code)}
              <Table.Row class="cursor-pointer" onclick={() => goto(`/currencies/${c.code}`)}>
                <Table.Cell class="font-mono">
                  {c.code}
                  {#if c.is_hidden}
                    <span class="ml-1 text-xs text-muted-foreground">{m.label_hidden()}</span>
                  {/if}
                </Table.Cell>
                <Table.Cell onclick={(e: MouseEvent) => { if (renamingCode === c.code) e.stopPropagation(); }}>
                  {#if renamingCode === c.code}
                    <Input
                      bind:value={renameValue}
                      class="h-7 text-sm"
                      onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { renamingCode = ""; } }}
                      onblur={() => commitRename()}
                    />
                  {:else}
                    {c.name}
                  {/if}
                </Table.Cell>
                {#if colVis.type !== false}
                  <Table.Cell class="hidden sm:table-cell">
                    {@const assetType = effectiveAssetType(c)}
                    {#if assetType}
                      <span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{assetType}</span>
                    {/if}
                  </Table.Cell>
                {/if}
                {#if colVis.lastPrice !== false}
                  <Table.Cell class="text-right hidden md:table-cell font-mono text-xs">
                    {#if c.is_base}
                      —
                    {:else if lastPrices.has(c.code)}
                      {lastPrices.get(c.code)!.toLocaleString(undefined, { maximumSignificantDigits: 6 })}
                    {:else}
                      <span class="text-muted-foreground">—</span>
                    {/if}
                  </Table.Cell>
                {/if}
                {#if colVis.holdings === true}
                  <Table.Cell class="text-right hidden md:table-cell font-mono text-xs">
                    {#if holdings.has(c.code)}
                      {holdings.get(c.code)!.toLocaleString(undefined, { maximumFractionDigits: c.decimal_places })}
                    {:else}
                      <span class="text-muted-foreground">—</span>
                    {/if}
                  </Table.Cell>
                {/if}
                {#if colVis.value !== false}
                  <Table.Cell class="text-right hidden md:table-cell font-mono text-xs">
                    {@const h = holdings.get(c.code) ?? 0}
                    {@const p = c.is_base ? 1 : (lastPrices.get(c.code) ?? 0)}
                    {@const val = h * p}
                    {#if val !== 0}
                      {val.toLocaleString(undefined, { maximumFractionDigits: 2 })} {settings.currency}
                    {:else}
                      <span class="text-muted-foreground">—</span>
                    {/if}
                  </Table.Cell>
                {/if}
                {#if colVis.decimals !== false}
                  <Table.Cell class="text-right hidden lg:table-cell">{c.decimal_places}</Table.Cell>
                {/if}
                {#if colVis.base !== false}
                  <Table.Cell class="hidden lg:table-cell">
                    {#if c.is_base}
                      <span class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{m.label_base()}</span>
                    {/if}
                  </Table.Cell>
                {/if}
                {#if colVis.rateSource === true}
                  <Table.Cell class="hidden xl:table-cell" onclick={(e: MouseEvent) => e.stopPropagation()}>
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
                {/if}
                <Table.Cell class="text-right" onclick={(e: MouseEvent) => e.stopPropagation()}>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button variant="ghost" size="icon-sm" {...props}>
                          <EllipsisVertical class="h-4 w-4" />
                          <span class="sr-only">{m.label_actions()}</span>
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Item onclick={() => startRename(c.code, c.name)}>{m.btn_rename()}</DropdownMenu.Item>
                      {#if !c.is_base}
                        {#if c.is_hidden}
                          <DropdownMenu.Item onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_unhide()}</DropdownMenu.Item>
                        {:else}
                          <DropdownMenu.Item onclick={async () => { await markCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_hide()}</DropdownMenu.Item>
                        {/if}
                      {/if}
                      {#if dpriceEnabled}
                        <DropdownMenu.Item onclick={() => { dpriceDialogCode = c.code; dpriceDialogOpen = true; }}>{m.btn_link_dprice()}</DropdownMenu.Item>
                      {/if}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
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
                <Table.Row class="cursor-pointer" onclick={() => goto(`/currencies/${c.code}`)}>
                  <Table.Cell class="font-mono">{c.code}</Table.Cell>
                  <Table.Cell>{c.name}</Table.Cell>
                  <Table.Cell class="text-right" onclick={(e: MouseEvent) => e.stopPropagation()}>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                          <Button variant="ghost" size="icon-sm" {...props}>
                            <EllipsisVertical class="h-4 w-4" />
                            <span class="sr-only">{m.label_actions()}</span>
                          </Button>
                        {/snippet}
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item onclick={async () => { await unmarkCurrencyHidden(getBackend(), c.code); await loadCurrencies(); }}>{m.btn_unhide()}</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
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
