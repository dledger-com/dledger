<script lang="ts">
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { getBackend } from "$lib/backend.js";
  import { importData } from "$lib/export/import.js";
  import { deserializeExport } from "$lib/export/format.js";
  import type { ExportHeader, ExportManifest, ImportMode, ImportProgress } from "$lib/export/types.js";
  import { toast } from "svelte-sonner";
  import { invalidate } from "$lib/data/invalidation.js";
  import Upload from "lucide-svelte/icons/upload";
  import FileText from "lucide-svelte/icons/file-text";
  import Eye from "lucide-svelte/icons/eye";
  import EyeOff from "lucide-svelte/icons/eye-off";
  import Loader from "lucide-svelte/icons/loader";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import { unzipSync, strFromU8 } from "fflate";
  import { decrypt } from "$lib/export/encrypt.js";

  let {
    open = $bindable(false),
    initialFile = undefined,
  }: {
    open: boolean;
    initialFile?: File;
  } = $props();

  // Steps: "select" | "passphrase" | "preview" | "importing"
  let step = $state<"select" | "passphrase" | "preview" | "importing">("select");

  // File state
  let fileName = $state("");
  let fileBytes = $state<Uint8Array | null>(null);
  let header = $state<ExportHeader | null>(null);
  let manifest = $state<ExportManifest | null>(null);

  // Options
  let passphrase = $state("");
  let showPassphrase = $state(false);
  let mode = $state<ImportMode>("replace");
  let importSettings = $state(true);

  // Progress
  let importing = $state(false);
  let progress = $state<ImportProgress | null>(null);
  let error = $state("");

  function resetDialog() {
    step = "select";
    fileName = "";
    fileBytes = null;
    header = null;
    manifest = null;
    passphrase = "";
    showPassphrase = false;
    mode = "replace";
    importSettings = true;
    importing = false;
    progress = null;
    error = "";
  }

  $effect.pre(() => {
    if (open && initialFile) {
      untrack(() => resetDialog());
      untrack(() => loadFile(initialFile));
    } else if (open) {
      untrack(() => resetDialog());
    }
  });

  async function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    await loadFile(file);
  }

  async function loadFile(file: File) {
    error = "";
    fileName = file.name;
    try {
      const buf = await file.arrayBuffer();
      fileBytes = new Uint8Array(buf);
      const result = deserializeExport(fileBytes);
      header = result.header;

      if (header.encrypted) {
        step = "passphrase";
      } else {
        // Extract manifest directly from unencrypted payload
        await extractManifest(result.payload);
        step = "preview";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to read file";
    }
  }

  async function extractManifest(zipBytes: Uint8Array) {
    try {
      const files = unzipSync(zipBytes);
      if (files["manifest.json"]) {
        manifest = JSON.parse(strFromU8(files["manifest.json"]));
      }
    } catch {
      error = "Failed to extract manifest from archive.";
    }
  }

  async function handleDecryptAndPreview() {
    if (!fileBytes || !header || !header.encryption) return;
    error = "";

    try {
      const { payload } = deserializeExport(fileBytes);
      const zipBytes = await decrypt(
        payload,
        passphrase,
        header.encryption.saltBase64,
        header.encryption.ivBase64,
      );
      await extractManifest(zipBytes);
      step = "preview";
    } catch {
      error = "Decryption failed. Wrong passphrase?";
    }
  }

  async function handleImport() {
    if (!fileBytes) return;
    importing = true;
    step = "importing";
    error = "";

    try {
      const backend = getBackend();
      const result = await importData(
        backend,
        fileBytes,
        {
          passphrase: passphrase || undefined,
          mode,
          importSettings,
        },
        (p) => { progress = { ...p }; },
      );

      invalidate("journal", "accounts", "currencies", "reports");

      const parts: string[] = [];
      if (result.accounts_imported > 0) parts.push(`${result.accounts_imported} accounts`);
      if (result.entries_imported > 0) parts.push(`${result.entries_imported} entries`);
      if (result.currencies_imported > 0) parts.push(`${result.currencies_imported} currencies`);
      if (result.rates_imported > 0) parts.push(`${result.rates_imported} rates`);
      if (result.plugins_imported > 0) parts.push(`${result.plugins_imported} plugins`);
      const summary = parts.length > 0 ? `Imported ${parts.join(", ")}` : "Import complete (no new data)";
      if (result.skipped > 0) {
        toast.success(`${summary}. ${result.skipped} skipped.`);
      } else {
        toast.success(summary);
      }
      if (result.warnings.length > 0) {
        toast.warning(`${result.warnings.length} warning(s) during import`);
      }
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Import failed";
      step = "preview";
    } finally {
      importing = false;
    }
  }

  function formatPhase(p: ImportProgress): string {
    switch (p.phase) {
      case "decrypting": return "Decrypting...";
      case "extracting": return "Extracting archive...";
      case "validating": return "Validating data...";
      case "importing":
        if (p.entity) return `Importing ${p.entity}... (${p.current}/${p.total})`;
        return `Importing... (${p.current}/${p.total})`;
    }
  }

  let progressPercent = $derived(
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0,
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[520px]">
    <Dialog.Header>
      <Dialog.Title>Import .dledger file</Dialog.Title>
      <Dialog.Description>
        {#if step === "select"}
          Select a .dledger export file to import.
        {:else if step === "passphrase"}
          This file is encrypted. Enter the passphrase to continue.
        {:else if step === "preview"}
          Review the data before importing.
        {:else}
          Importing data...
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <!-- Step: Select file -->
    {#if step === "select"}
      <div class="space-y-4">
        <label
          class="flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-input px-4 py-8 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Upload class="h-5 w-5" />
          <span>{fileName || "Choose .dledger file or drop here"}</span>
          <input type="file" accept=".dledger" class="hidden" onchange={handleFileChange} />
        </label>

        {#if error}
          <div class="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert class="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Step: Passphrase -->
    {#if step === "passphrase"}
      <div class="space-y-4">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText class="h-4 w-4" />
          <span>{fileName}</span>
        </div>

        <div class="space-y-2">
          <p class="text-sm font-medium">Passphrase</p>
          <div class="relative">
            <Input
              type={showPassphrase ? "text" : "password"}
              placeholder="Enter the export passphrase"
              bind:value={passphrase}
              class="pr-10"
              onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && passphrase) handleDecryptAndPreview(); }}
            />
            <button
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onclick={() => showPassphrase = !showPassphrase}
            >
              {#if showPassphrase}
                <EyeOff class="h-4 w-4" />
              {:else}
                <Eye class="h-4 w-4" />
              {/if}
            </button>
          </div>
        </div>

        {#if error}
          <div class="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert class="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}

        <Dialog.Footer>
          <Button variant="outline" onclick={() => { step = "select"; error = ""; }}>
            Back
          </Button>
          <Button onclick={handleDecryptAndPreview} disabled={!passphrase}>
            Decrypt &amp; Preview
          </Button>
        </Dialog.Footer>
      </div>
    {/if}

    <!-- Step: Preview -->
    {#if step === "preview"}
      <div class="space-y-4">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText class="h-4 w-4" />
          <span>{fileName}</span>
          {#if header?.encrypted}
            <span class="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">Encrypted</span>
          {/if}
        </div>

        <!-- Manifest summary -->
        {#if manifest}
          <div class="rounded-md border bg-muted/30 p-3 space-y-2">
            <h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contents</h4>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
              {#each Object.entries(manifest.entities) as [key, count]}
                <div>
                  <span class="text-xs text-muted-foreground">{key}</span>
                  <p class="font-mono text-xs">{count.toLocaleString()}</p>
                </div>
              {/each}
            </div>
            <div class="text-xs text-muted-foreground mt-1">
              Exported {new Date(manifest.exportedAt).toLocaleDateString()} &middot; v{manifest.appVersion}
            </div>
          </div>
        {/if}

        <!-- Import mode -->
        <div class="space-y-2">
          <p class="text-sm font-medium">Import mode</p>
          <div class="flex gap-2">
            <Button
              size="sm"
              variant={mode === "replace" ? "default" : "outline"}
              onclick={() => { mode = "replace"; importSettings = true; }}
            >
              Replace all data
            </Button>
            <Button
              size="sm"
              variant={mode === "merge-skip" ? "default" : "outline"}
              onclick={() => { mode = "merge-skip"; importSettings = false; }}
            >
              Merge (skip conflicts)
            </Button>
          </div>
          {#if mode === "replace"}
            <p class="text-xs text-destructive">
              Warning: this will clear all existing data before importing.
            </p>
          {/if}
        </div>

        <!-- Import settings checkbox -->
        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={importSettings} />
          Import settings
        </label>

        {#if error}
          <div class="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert class="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}

        <Dialog.Footer>
          <Button variant="outline" onclick={() => open = false}>
            Cancel
          </Button>
          <Button onclick={handleImport}>
            <Upload class="mr-1 h-4 w-4" />
            Import
          </Button>
        </Dialog.Footer>
      </div>
    {/if}

    <!-- Step: Importing -->
    {#if step === "importing"}
      <div class="space-y-4">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader class="h-4 w-4 animate-spin" />
          <span>{progress ? formatPhase(progress) : "Starting import..."}</span>
        </div>

        <!-- Progress bar -->
        <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            class="h-full bg-primary transition-all duration-300"
            style="width: {progressPercent}%"
          ></div>
        </div>

        {#if error}
          <div class="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert class="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
