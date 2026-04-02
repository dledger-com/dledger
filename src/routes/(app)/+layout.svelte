<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import AppSidebar from "$lib/components/shell/AppSidebar.svelte";
  import TopBar from "$lib/components/shell/TopBar.svelte";
  import BottomTabBar from "$lib/components/shell/BottomTabBar.svelte";
  import GlobalDropZone from "$lib/components/GlobalDropZone.svelte";
  import BatchImportBar from "$lib/components/BatchImportBar.svelte";
  const CsvImportDialog = () => import("$lib/components/CsvImportDialog.svelte");
  const OfxImportDialog = () => import("$lib/components/OfxImportDialog.svelte");
  const PdfImportDialog = () => import("$lib/components/PdfImportDialog.svelte");
  const LedgerImportDialog = () => import("$lib/components/LedgerImportDialog.svelte");
  const DledgerImportDialog = () => import("$lib/components/DledgerImportDialog.svelte");
  const FeedbackWizardDialog = () => import("$lib/components/FeedbackWizardDialog.svelte");
  import { importDrop } from "$lib/data/import-drop.svelte.js";
  import { SettingsStore } from "$lib/data/settings.svelte.js";
  import { setFormatLocale } from "$lib/utils/format.js";
  import { untrack } from "svelte";
  import { onMount } from "svelte";
  import { getBackend } from "$lib/backend.js";
  import { initCoinIcons, setAssetProxy, setCryptoGeckoIds } from "$lib/data/coin-icons.svelte.js";
  import { loadCustomPlugins } from "$lib/plugins/custom-plugins.js";
  import { onInvalidate } from "$lib/data/invalidation.js";
  import { feedbackWizard } from "$lib/data/feedback.svelte.js";
  import { createDpriceClient } from "$lib/dprice-client.js";

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
    });
    setAssetProxy((url) => dpriceClient.proxyAsset(url));

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
    loadCustomPlugins(backend).catch(() => { /* non-critical */ });

    // Re-initialize icons when new currencies are created (e.g., after CSV/OFX import)
    return onInvalidate("currencies", refreshIcons);
  });

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
  <AppSidebar onfeedback={() => { feedbackWizard.openDefault(); }} />
  <Sidebar.Inset>
    <TopBar showSidebarTrigger={isDesktop.current} />
    <main class="flex-1 flex flex-col overflow-auto p-4 pb-20 md:pb-4">
      {@render children?.()}
    </main>
  </Sidebar.Inset>
  <BottomTabBar onfeedback={() => { feedbackWizard.openDefault(); }} />
</Sidebar.Provider>

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
