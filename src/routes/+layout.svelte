<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { initBackend, getBackend } from "$lib/backend.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { syncExchangeRates } from "$lib/exchange-rate-sync.js";
  import { onMount } from "svelte";

  let { children } = $props();

  let ready = $state(false);

  onMount(async () => {
    try {
      await initBackend();
      ready = true;

      // Daily auto-sync: fire-and-forget
      const settings = new SettingsStore();
      const today = new Date().toISOString().slice(0, 10);
      if (settings.lastRateSync !== today) {
        syncExchangeRates(
          getBackend(),
          settings.currency,
          settings.coingeckoApiKey,
          settings.finnhubApiKey,
          settings.hiddenCurrencySet,
        ).then(() => {
          settings.update({ lastRateSync: today });
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
