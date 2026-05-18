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
  import * as m from "$paraglide/messages.js";

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
        toast.warning(m.toast_missing_rates_partial({ count: String(result.fetched), currencies: result.failedCurrencies.join(", ") }));
      } else {
        toast.success(m.toast_missing_rates_fetched());
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
        {m.banner_missing_rates_for({ currencies: requests.map((r) => r.currency).join(", ") })}
      </span>
      <Button size="sm" onclick={handleFetch} disabled={fetchingRates}>
        {fetchingRates ? m.state_fetching() : m.btn_fetch_missing_rates()}
      </Button>
    </Card.Content>
  </Card.Root>
{/if}
