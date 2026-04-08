<svelte:head><title>{m.report_portfolio()} · dLedger</title></svelte:head>

<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { formatCurrency } from "$lib/utils/format.js";
  import { getBackend } from "$lib/backend.js";
  import { computePortfolioReport, type PortfolioReport } from "$lib/utils/portfolio.js";
  import { exportPortfolioCsv } from "$lib/utils/csv-export.js";
  import { SUPPORTED_CHAINS } from "$lib/types/index.js";
  import { getHiddenCurrencySet } from "$lib/data/hidden-currencies.svelte.js";
  import {
    findMissingRates,
    resolveDpriceAssets,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import MissingRateBanner from "$lib/components/MissingRateBanner.svelte";
  import CoinIcon from "$lib/components/CoinIcon.svelte";
  import SortableHeader from "$lib/components/SortableHeader.svelte";
  import { createSortState, sortItems } from "$lib/utils/sort.svelte.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import * as m from "$paraglide/messages.js";

  type PortSortKey = "currency" | "amount" | "value";
  const portSort = createSortState<PortSortKey>();

  const settings = new SettingsStore();
  let asOf = $state(new Date().toISOString().slice(0, 10));
  let loading = $state(false);
  let report = $state<PortfolioReport | null>(null);
  let error = $state<string | null>(null);
  let missingRateRequests = $state<HistoricalRateRequest[]>([]);

  function chainName(chainId: number): string {
    const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
    return chain ? chain.name : `Chain ${chainId}`;
  }

  async function generate() {
    loading = true;
    error = null;
    report = null;
    missingRateRequests = [];
    try {
      const hidden = settings.showHidden ? new Set<string>() : getHiddenCurrencySet();
      report = await computePortfolioReport(
        getBackend(),
        settings.currency,
        asOf,
        hidden,
      );
      if (report.missingCurrencies.length > 0) {
        const currencyDates = report.missingCurrencies.map((currency) => ({ currency, date: asOf }));
        const rateConfig = settings.buildRateConfig();
        const dpriceAssets = await resolveDpriceAssets(rateConfig, report.missingCurrencies);
        missingRateRequests = await findMissingRates(
          getBackend(),
          settings.currency,
          currencyDates,
          dpriceAssets,
          undefined,
          rateConfig.disabledSources,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(generate);

  let hasWallets = $derived(report !== null && report.wallets.length > 0);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end gap-3">
    <div class="space-y-2">
      <label for="asOf" class="text-sm font-medium">{m.report_as_of_date()}</label>
      <Input id="asOf" type="date" bind:value={asOf} class="w-full sm:w-48" />
    </div>
    <Button onclick={generate} disabled={loading}>
      {loading ? m.state_loading() : m.btn_generate()}
    </Button>
    {#if hasWallets && report}
      <Button variant="outline" onclick={() => exportPortfolioCsv(report!)}>
        {m.report_export_csv()}
      </Button>
    {/if}
    <div class="flex items-center gap-2">
      <Switch checked={settings.showHidden} onCheckedChange={(v) => { settings.update({ showHidden: v }); generate(); }} />
      <span class="text-sm text-muted-foreground">{m.report_show_hidden()}</span>
    </div>
  </div>

  <MissingRateBanner requests={missingRateRequests} onFetched={generate} />

  {#if loading}
    <Card.Root><Card.Content class="py-4">
      {#each [1, 2, 3] as _}<Skeleton class="h-10 w-full mb-2" />{/each}
    </Card.Content></Card.Root>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8">
        <p class="text-sm text-destructive text-center">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if !hasWallets}
    <Card.Root>
      <Card.Content class="py-8">
        <EmptyState message={m.empty_no_wallet_holdings()} />
      </Card.Content>
    </Card.Root>
  {:else if report}
    {#if report.aggregate_total !== null}
      <Card.Root>
        <Card.Header>
          <div class="flex items-center justify-between">
            <Card.Title>{m.report_aggregate_total()}</Card.Title>
            <span class="text-xl font-bold">
              {formatCurrency(parseFloat(report.aggregate_total), settings.currency)}
            </span>
          </div>
          <Card.Description>
            {m.report_combined_value({ count: String(report.wallets.length), date: report.as_of })}
          </Card.Description>
        </Card.Header>
      </Card.Root>
    {/if}

    {#each report.wallets as wallet}
      <Card.Root>
        <Card.Header>
          <div class="flex items-center justify-between">
            <div>
              <Card.Title>{wallet.label}</Card.Title>
              <Card.Description class="font-mono text-xs mt-1">
                {wallet.address}
                <Badge variant="outline" class="ml-2">{chainName(wallet.chainId)}</Badge>
              </Card.Description>
            </div>
            {#if wallet.totalBaseValue !== null}
              <span class="text-lg font-semibold">
                {formatCurrency(parseFloat(wallet.totalBaseValue), settings.currency)}
              </span>
            {/if}
          </div>
        </Card.Header>
        <Card.Content>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <SortableHeader active={portSort.key === "currency"} direction={portSort.direction} onclick={() => portSort.toggle("currency")}>{m.label_currency()}</SortableHeader>
                <SortableHeader active={portSort.key === "amount"} direction={portSort.direction} onclick={() => portSort.toggle("amount")} class="text-right">{m.label_amount()}</SortableHeader>
                <SortableHeader active={portSort.key === "value"} direction={portSort.direction} onclick={() => portSort.toggle("value")} class="text-right">{m.report_value_in({ currency: settings.currency })}</SortableHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {@const sortedHoldings = portSort.key && portSort.direction ? sortItems(wallet.holdings, portSort.key === "currency" ? (h) => h.currency : portSort.key === "amount" ? (h) => parseFloat(h.amount) : (h) => h.baseValue ? parseFloat(h.baseValue) : 0, portSort.direction) : wallet.holdings}
              {#each sortedHoldings as holding}
                <Table.Row>
                  <Table.Cell>
                    <span class="inline-flex items-center gap-1"><CoinIcon code={holding.currency} size={14} /><Badge variant="outline">{holding.currency}</Badge></span>
                  </Table.Cell>
                  <Table.Cell class="text-right font-mono">{holding.amount}</Table.Cell>
                  <Table.Cell class="text-right font-mono">
                    {holding.baseValue !== null
                      ? formatCurrency(parseFloat(holding.baseValue), settings.currency)
                      : "-"}
                  </Table.Cell>
                </Table.Row>
              {/each}
              {#if wallet.totalBaseValue !== null}
                <Table.Row class="font-semibold border-t-2">
                  <Table.Cell>{m.report_total()}</Table.Cell>
                  <Table.Cell></Table.Cell>
                  <Table.Cell class="text-right font-mono">
                    {formatCurrency(parseFloat(wallet.totalBaseValue), settings.currency)}
                  </Table.Cell>
                </Table.Row>
              {/if}
            </Table.Body>
          </Table.Root>
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>
