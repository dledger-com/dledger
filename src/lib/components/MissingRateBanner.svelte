<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import {
    fetchHistoricalRates,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import { markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { toast } from "svelte-sonner";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";

  interface Props {
    requests: HistoricalRateRequest[];
    onFetched: () => void;
    baseCurrency?: string;
  }

  let { requests, onFetched, baseCurrency }: Props = $props();

  const settings = new SettingsStore();
  let fetchingRates = $state(false);

  async function handleFetch() {
    fetchingRates = true;
    try {
      const result = await fetchHistoricalRates(
        getBackend(),
        requests,
        {
          baseCurrency: baseCurrency ?? settings.currency,
          coingeckoApiKey: settings.coingeckoApiKey,
          finnhubApiKey: settings.finnhubApiKey,
          cryptoCompareApiKey: settings.cryptoCompareApiKey,
        },
      );

      if (result.failedCurrencies.length > 0) {
        const backend = getBackend();
        for (const code of result.failedCurrencies) {
          await backend.setCurrencyRateSource(code, "none", "auto");
          await markCurrencyHidden(backend, code);
        }
        showAutoHideToast(result.failedCurrencies);
      }

      onFetched();

      if (result.failedCurrencies.length > 0) {
        toast.success(`Fetched ${result.fetched} rate(s), auto-hid ${result.failedCurrencies.length} currency(ies)`);
      } else {
        toast.success("Missing rates fetched");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      fetchingRates = false;
    }
  }
</script>

{#if requests.length > 0}
  <Card.Root class="border-amber-200 dark:border-amber-800">
    <Card.Content class="flex items-center justify-between py-3">
      <span class="text-sm">
        Missing rates for {requests.map((r) => r.currency).join(", ")}.
      </span>
      <Button size="sm" onclick={handleFetch} disabled={fetchingRates}>
        {fetchingRates ? "Fetching..." : "Fetch Missing Rates"}
      </Button>
    </Card.Content>
  </Card.Root>
{/if}
