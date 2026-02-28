<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { initBackend, getBackend, disposeBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { loadHiddenCurrencies, getHiddenCurrencySet, markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { syncExchangeRates } from "$lib/exchange-rate-sync.js";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { onMount } from "svelte";

  let { children } = $props();

  let ready = $state(false);

  const handlePageHide = () => disposeBackend();

  onMount(() => {
    window.addEventListener("pagehide", handlePageHide);

    (async () => {
      try {
        const backend = await initBackend();
        await loadHiddenCurrencies(backend);

        // Configure account paths from saved settings before rendering children
        const settings = new SettingsStore();
        ready = true;
        const today = new Date().toISOString().slice(0, 10);
        if (settings.lastRateSync !== today) {
          taskQueue.enqueue({
            key: "rate-sync",
            label: "Daily rate sync",
            async run() {
              const syncResult = await syncExchangeRates(
                backend,
                settings.currency,
                settings.coingeckoApiKey,
                settings.finnhubApiKey,
                getHiddenCurrencySet(),
                settings.cryptoCompareApiKey,
                settings.settings.dpriceEnabled,
                settings.settings.dpriceUrl,
              );
              settings.update({ lastRateSync: today });
              for (const code of syncResult.autoHidden) {
                await markCurrencyHidden(backend, code);
              }
              if (syncResult.autoHidden.length > 0) {
                showAutoHideToast(syncResult.autoHidden);
              }
              return { summary: `${syncResult.rates_fetched} rates synced` };
            },
          });
        }
      } catch (e) {
        console.error("Backend init failed:", e);
      }
    })();

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  });
</script>

<ModeWatcher />
<Toaster />
{#if ready}
  {@render children?.()}
{/if}
