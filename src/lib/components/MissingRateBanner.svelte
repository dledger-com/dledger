<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { getBackend } from "$lib/backend.js";
  import {
    fetchHistoricalRates,
    resolveDpriceAssets,
    type HistoricalRateRequest,
  } from "$lib/exchange-rate-historical.js";
  import { toast } from "svelte-sonner";

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
      const config = {
        ...settings.buildRateConfig(),
        baseCurrency: baseCurrency ?? settings.currency,
      };

      const currencies = [...new Set(requests.map((r) => r.currency))];
      const dpriceAssets = await resolveDpriceAssets(config, currencies);

      const result = await fetchHistoricalRates(
        getBackend(),
        requests,
        config,
        dpriceAssets,
      );

      onFetched();

      if (result.failedCurrencies.length > 0) {
        toast.warning(`Fetched ${result.fetched} rate(s), could not find rates for: ${result.failedCurrencies.join(", ")}`);
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
