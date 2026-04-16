<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import AppSidebar from "$lib/components/shell/AppSidebar.svelte";
  import TopBar from "$lib/components/shell/TopBar.svelte";
  import BottomTabBar from "$lib/components/shell/BottomTabBar.svelte";
  import GlobalDropZone from "$lib/components/GlobalDropZone.svelte";
  import BatchImportBar from "$lib/components/BatchImportBar.svelte";
  import DemoBanner from "$lib/components/DemoBanner.svelte";
  import { DEMO_MODE } from "$lib/demo.js";
  const CsvImportDialog = () => import("$lib/components/CsvImportDialog.svelte");
  const OfxImportDialog = () => import("$lib/components/OfxImportDialog.svelte");
  const QifImportDialog = () => import("$lib/components/QifImportDialog.svelte");
  const PdfImportDialog = () => import("$lib/components/PdfImportDialog.svelte");
  const LedgerImportDialog = () => import("$lib/components/LedgerImportDialog.svelte");
  const DledgerImportDialog = () => import("$lib/components/DledgerImportDialog.svelte");
  const FeedbackWizardDialog = () => import("$lib/components/FeedbackWizardDialog.svelte");
  const BackupInfoDialog = () => import("$lib/components/BackupInfoDialog.svelte");
  import { importDrop } from "$lib/data/import-drop.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { setFormatLocale } from "$lib/utils/format.js";
  import { untrack } from "svelte";
  import { onMount } from "svelte";
  import { getBackend } from "$lib/backend.js";
  import { initCoinIcons, setAssetProxy, setCryptoGeckoIds, setAsyncGeckoIdResolver } from "$lib/data/coin-icons.svelte.js";
  import { loadCustomPlugins } from "$lib/plugins/custom-plugins.js";
  import { onInvalidate, invalidate } from "$lib/data/invalidation.js";
  import { COMMON_CURRENCIES } from "$lib/data/common-currencies.js";
  import { feedbackWizard } from "$lib/data/feedback.svelte.js";
  import { createDpriceClient } from "$lib/dprice-client.js";
  import { exportData, downloadExport } from "$lib/export/export.js";
  import { saveToStorage, loadSettings } from "$lib/data/settings.svelte.js";
  import { toast } from "svelte-sonner";
  import * as m from "$paraglide/messages.js";

  let { children } = $props();

  const settings = new SettingsStore();

  $effect(() => {
    setFormatLocale(settings.locale);
  });

  const isDesktop = new MediaQuery("(min-width: 768px)");

  // Initialize coin icon cache and load custom plugins (non-blocking, best-effort)
  onMount(() => {
    const backend = getBackend();

    // Set up dprice asset proxy for CORS-blocked icon URLs
    const dpriceClient = createDpriceClient({
      dpriceMode: settings.settings.dpriceMode,
      dpriceUrl: settings.settings.dpriceUrl,
      dpriceApiKey: settings.settings.dpriceApiKey,
    });
    setAssetProxy((url) => dpriceClient.proxyAsset(url));
    setAsyncGeckoIdResolver(async (symbols) => {
      try {
        const grouped = await dpriceClient.queryAssetsBatch(symbols, 1);
        const result = new Map<string, string | null>();
        for (const sym of symbols) {
          const assets = grouped.get(sym.toUpperCase()) ?? [];
          const geckoId = assets[0]?.coingecko_id ?? null;
          result.set(sym, geckoId);
          // Persist both positive and negative results so we don't re-query on next refresh
          try { await backend.setCryptoAssetCoingeckoId(sym, geckoId ?? ""); } catch { /* non-critical */ }
        }
        return result;
      } catch { return new Map(symbols.map(s => [s, null])); }
    });

    // Ensure the base currency exists in the database on startup.
    // Skipped in demo mode — the snapshot already has every currency.
    if (!DEMO_MODE) {
      const baseCurrency = settings.currency;
      if (baseCurrency) {
        const name = COMMON_CURRENCIES.find((c) => c.code === baseCurrency)?.name ?? baseCurrency;
        backend.createCurrency({
          code: baseCurrency,
          asset_type: "",
          name,
          decimal_places: baseCurrency.length <= 3 ? 2 : 8,
        }).catch(() => { /* already exists — expected */ });
      }
    }

    const refreshIcons = () => {
      Promise.all([
        backend.listCurrencies(),
        backend.listCryptoAssetInfo(),
      ]).then(([currencies, geckoIds]) => {
        setCryptoGeckoIds(geckoIds);
        initCoinIcons(currencies.map((c) => c.code));
      }).catch(() => { /* non-critical */ });
    };
    refreshIcons();
    loadCustomPlugins(backend).then(() => invalidate("plugins")).catch(() => { /* non-critical */ });

    // Re-initialize icons when new currencies are created (e.g., after CSV/OFX import)
    return onInvalidate("currencies", refreshIcons);
  });

  let backupInfoOpen = $state(false);

  async function handleQuickExportFromDialog() {
    try {
      const backend = getBackend();
      const data = await exportData(backend, {});
      downloadExport(data, false);
      const s = loadSettings();
      s.lastExportDate = new Date().toISOString();
      saveToStorage(s);
      toast.success(m.toast_quick_export_success());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  }

  // Clear content when dialogs close, and advance batch queue.
  // scheduleAdvance() is wrapped in untrack() so these effects only
  // depend on the dialog open/close state, not on queue internals.
  $effect(() => {
    if (!importDrop.csvOpen) {
      importDrop.csvContent = "";
      importDrop.csvFileName = "";
      untrack(() => importDrop.scheduleAdvance());
    }
  });
  $effect(() => {
    if (!importDrop.ofxOpen) {
      importDrop.ofxContent = "";
      importDrop.ofxFileName = "";
      untrack(() => importDrop.scheduleAdvance());
    }
  });
  $effect(() => {
    if (!importDrop.qifOpen) {
      importDrop.qifContent = "";
      importDrop.qifFileName = "";
      untrack(() => importDrop.scheduleAdvance());
    }
  });
  $effect(() => {
    if (!importDrop.pdfOpen) {
      importDrop.pdfFile = null;
      importDrop.pdfFileName = "";
      untrack(() => importDrop.scheduleAdvance());
    }
  });
  $effect(() => {
    if (!importDrop.ledgerOpen) {
      importDrop.ledgerContent = "";
      importDrop.ledgerFileName = "";
      untrack(() => importDrop.scheduleAdvance());
    }
  });
  $effect(() => {
    if (!importDrop.dledgerOpen) {
      importDrop.dledgerFile = null;
      untrack(() => importDrop.scheduleAdvance());
    }
  });
</script>

<Sidebar.Provider>
  <AppSidebar onfeedback={() => { feedbackWizard.openDefault(); }} onbackupinfo={() => { backupInfoOpen = true; }} />
  <Sidebar.Inset class="min-w-0">
    {#if DEMO_MODE}
      <DemoBanner />
    {/if}
    <TopBar showSidebarTrigger={isDesktop.current} />
    <main class="flex-1 flex flex-col overflow-auto p-4 pb-20 md:pb-4 min-w-0">
      {@render children?.()}
    </main>
  </Sidebar.Inset>
  <BottomTabBar onfeedback={() => { feedbackWizard.openDefault(); }} />
</Sidebar.Provider>

{#if !DEMO_MODE}
  <GlobalDropZone />
  <BatchImportBar />

  {#if importDrop.ledgerOpen}
    {#await LedgerImportDialog() then mod}
      <mod.default
        bind:open={importDrop.ledgerOpen}
        initialContent={importDrop.ledgerContent}
        initialFileName={importDrop.ledgerFileName}
      />
    {/await}
  {/if}
  {#if importDrop.csvOpen}
    {#await CsvImportDialog() then mod}
      <mod.default
        bind:open={importDrop.csvOpen}
        initialContent={importDrop.csvContent}
        initialFileName={importDrop.csvFileName}
      />
    {/await}
  {/if}
  {#if importDrop.ofxOpen}
    {#await OfxImportDialog() then mod}
      <mod.default
        bind:open={importDrop.ofxOpen}
        initialContent={importDrop.ofxContent}
        initialFileName={importDrop.ofxFileName}
      />
    {/await}
  {/if}
  {#if importDrop.qifOpen}
    {#await QifImportDialog() then mod}
      <mod.default
        bind:open={importDrop.qifOpen}
        initialContent={importDrop.qifContent}
        initialFileName={importDrop.qifFileName}
      />
    {/await}
  {/if}
  {#if importDrop.pdfOpen}
    {#await PdfImportDialog() then mod}
      <mod.default
        bind:open={importDrop.pdfOpen}
        initialFile={importDrop.pdfFile}
        initialFileName={importDrop.pdfFileName}
      />
    {/await}
  {/if}
  {#if importDrop.dledgerOpen}
    {#await DledgerImportDialog() then mod}
      <mod.default
        bind:open={importDrop.dledgerOpen}
        initialFile={importDrop.dledgerFile ?? undefined}
      />
    {/await}
  {/if}
  {#if feedbackWizard.open}
    {#await FeedbackWizardDialog() then mod}
      <mod.default bind:open={feedbackWizard.open} initialStep={feedbackWizard.initialStep} />
    {/await}
  {/if}
{/if}
{#if backupInfoOpen}
  {#await BackupInfoDialog() then mod}
    <mod.default bind:open={backupInfoOpen} onexport={handleQuickExportFromDialog} />
  {/await}
{/if}
