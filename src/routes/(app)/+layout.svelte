<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import AppSidebar from "$lib/components/shell/AppSidebar.svelte";
  import TopBar from "$lib/components/shell/TopBar.svelte";
  import BottomTabBar from "$lib/components/shell/BottomTabBar.svelte";
  import GlobalDropZone from "$lib/components/GlobalDropZone.svelte";
  import BatchImportBar from "$lib/components/BatchImportBar.svelte";
  import CsvImportDialog from "$lib/components/CsvImportDialog.svelte";
  import OfxImportDialog from "$lib/components/OfxImportDialog.svelte";
  import PdfImportDialog from "$lib/components/PdfImportDialog.svelte";
  import LedgerImportDialog from "$lib/components/LedgerImportDialog.svelte";
  import { importDrop } from "$lib/data/import-drop.svelte.js";

  let { children } = $props();

  const isDesktop = new MediaQuery("(min-width: 768px)");

  // Clear content when dialogs close, and advance batch queue
  $effect(() => {
    if (!importDrop.csvOpen) {
      importDrop.csvContent = "";
      importDrop.csvFileName = "";
      importDrop.scheduleAdvance();
    }
  });
  $effect(() => {
    if (!importDrop.ofxOpen) {
      importDrop.ofxContent = "";
      importDrop.ofxFileName = "";
      importDrop.scheduleAdvance();
    }
  });
  $effect(() => {
    if (!importDrop.pdfOpen) {
      importDrop.pdfFile = null;
      importDrop.pdfFileName = "";
      importDrop.scheduleAdvance();
    }
  });
  $effect(() => {
    if (!importDrop.ledgerOpen) {
      importDrop.ledgerContent = "";
      importDrop.ledgerFileName = "";
      importDrop.scheduleAdvance();
    }
  });
</script>

<Sidebar.Provider>
  <AppSidebar />
  <Sidebar.Inset>
    <TopBar showSidebarTrigger={isDesktop.current} />
    <main class="flex-1 flex flex-col overflow-auto p-4 pb-20 md:pb-4">
      {@render children?.()}
    </main>
  </Sidebar.Inset>
  <BottomTabBar />
</Sidebar.Provider>

<GlobalDropZone />
<BatchImportBar />

<LedgerImportDialog
  bind:open={importDrop.ledgerOpen}
  initialContent={importDrop.ledgerContent}
  initialFileName={importDrop.ledgerFileName}
/>
<CsvImportDialog
  bind:open={importDrop.csvOpen}
  initialContent={importDrop.csvContent}
  initialFileName={importDrop.csvFileName}
/>
<OfxImportDialog
  bind:open={importDrop.ofxOpen}
  initialContent={importDrop.ofxContent}
  initialFileName={importDrop.ofxFileName}
/>
<PdfImportDialog
  bind:open={importDrop.pdfOpen}
  initialFile={importDrop.pdfFile}
  initialFileName={importDrop.pdfFileName}
/>
