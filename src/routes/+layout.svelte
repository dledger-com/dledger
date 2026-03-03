<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { initBackend, getBackend, disposeBackend } from "$lib/backend.js";
  import { SettingsStore, computeRateConfigHash } from "$lib/data/settings.svelte.js";
  import { preWarmAccountCache } from "$lib/data/accounts.svelte.js";
  import { loadHiddenCurrencies, getHiddenCurrencySet, markCurrencyHidden } from "$lib/data/hidden-currencies.svelte.js";
  import { initInvalidationChannel, disposeInvalidationChannel } from "$lib/data/invalidation.js";
  import { enqueueRateBackfill, type HistoricalFetchConfig } from "$lib/exchange-rate-historical.js";
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import { createDpriceClient } from "$lib/dprice-client.js";
  import { isSpamCurrency } from "$lib/currency-validation.js";
  import { onMount } from "svelte";

  let { children } = $props();

  let ready = $state(false);

  const handlePageHide = () => {
    disposeInvalidationChannel();
    disposeBackend();
  };

  const RATE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  onMount(() => {
    window.addEventListener("pagehide", handlePageHide);
    initInvalidationChannel();

    let syncIntervalId: ReturnType<typeof setInterval> | undefined;

    (async () => {
      try {
        const backend = await initBackend();
        await loadHiddenCurrencies(backend);

        // Pre-warm account cache BEFORE rendering children (guarantees cache hit)
        const [accounts, currencies] = await Promise.all([
          backend.listAccounts(),
          backend.listCurrencies(),
        ]);
        preWarmAccountCache(accounts, currencies);

        const settings = new SettingsStore();
        ready = true;

        // --- One-time spam cleanup of existing currencies ---
        if (!settings.settings.spamCleanupDone) {
          let spamCount = 0;
          for (const c of currencies) {
            if (!c.is_hidden && isSpamCurrency(c.code)) {
              await markCurrencyHidden(backend, c.code);
              spamCount++;
            }
          }
          settings.update({ spamCleanupDone: true });
          if (spamCount > 0) {
            console.log(`Auto-hid ${spamCount} spam currency(ies)`);
          }
        }

        // --- Config change detection: reset auto "none" entries ---
        const currentHash = computeRateConfigHash(settings.settings);
        if (settings.settings.rateConfigHash && settings.settings.rateConfigHash !== currentHash) {
          await backend.clearAutoRateSources();
          console.log("Rate config changed — cleared auto-detected rate sources for retry");
        }
        settings.update({ rateConfigHash: currentHash });

        // --- dprice: startup sync (latest only — fast) ---
        const dpriceMode = settings.settings.dpriceMode;
        if (dpriceMode === "integrated") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((window as any).__TAURI_INTERNALS__) {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("dprice_set_mode", { mode: dpriceMode });
            }
          } catch {
            // Not in Tauri — ignore
          }
          taskQueue.enqueue({
            key: "dprice-startup-sync",
            label: "dprice latest prices",
            async run() {
              const client = createDpriceClient({
                dpriceMode,
                dpriceUrl: settings.settings.dpriceUrl,
              });
              await client.syncLatest();
              return { summary: "dprice prices updated" };
            },
          });
        }

        // --- Unified auto-sync (replaces old daily syncExchangeRates) ---
        const buildConfig = (): HistoricalFetchConfig => ({
          baseCurrency: settings.currency,
          coingeckoApiKey: settings.coingeckoApiKey,
          coingeckoPro: settings.settings.coingeckoPro,
          finnhubApiKey: settings.finnhubApiKey,
          cryptoCompareApiKey: settings.cryptoCompareApiKey,
          dpriceMode: settings.settings.dpriceMode,
          dpriceUrl: settings.settings.dpriceUrl,
        });

        // Startup auto-sync — findMissingRates is idempotent, no daily guard needed
        enqueueRateBackfill(taskQueue, backend, buildConfig(), getHiddenCurrencySet());

        // Periodic auto-sync every 30 minutes (only when tab is visible)
        syncIntervalId = setInterval(() => {
          if (document.visibilityState === "visible" && !taskQueue.isActive("rate-backfill")) {
            enqueueRateBackfill(taskQueue, backend, buildConfig(), getHiddenCurrencySet());
          }
        }, RATE_SYNC_INTERVAL_MS);
      } catch (e) {
        console.error("Backend init failed:", e);
      }
    })();

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      disposeInvalidationChannel();
      if (syncIntervalId) clearInterval(syncIntervalId);
    };
  });
</script>

<ModeWatcher />
<Toaster />
{#if ready}
  {@render children?.()}
{/if}
