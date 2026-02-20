<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { initBackend, getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { loadHiddenCurrencies, getHiddenCurrencySet, markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { syncExchangeRates } from "$lib/exchange-rate-sync.js";
  import { showAutoHideToast } from "$lib/utils/auto-hide-toast.js";
  import { onMount } from "svelte";

  let { children } = $props();

  let ready = $state(false);

  onMount(async () => {
    try {
      const backend = await initBackend();
      await loadHiddenCurrencies(backend);
      ready = true;

      // Daily auto-sync: fire-and-forget
      const settings = new SettingsStore();
      const today = new Date().toISOString().slice(0, 10);
      if (settings.lastRateSync !== today) {
        syncExchangeRates(
          backend,
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          getHiddenCurrencySet(),
        ).then(async (syncResult) => {
          settings.update({ lastRateSync: today });
          for (const code of syncResult.autoHidden) {
            await markCurrencyHidden(backend, code);
          }
          if (syncResult.autoHidden.length > 0) {
            showAutoHideToast(syncResult.autoHidden);
          }
        }).catch(() => {
          // Swallow errors — don't block the app
        });
      }
    } catch (e) {
      console.error("Backend init failed:", e);
    }
  });
</script>

<ModeWatcher />
<Toaster />
{#if ready}
  {@render children?.()}
{/if}
