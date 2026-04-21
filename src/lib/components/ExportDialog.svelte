<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { getBackend } from "$lib/backend.js";
  import { exportData, downloadExport } from "$lib/export/export.js";
  import {
    defaultExportSelection,
    type ExportSelection,
  } from "$lib/export/types.js";
  import { toast } from "svelte-sonner";
  import { loadSettings, saveToStorage } from "$lib/data/settings.svelte.js";
  import Download from "lucide-svelte/icons/download";
  import Eye from "lucide-svelte/icons/eye";
  import EyeOff from "lucide-svelte/icons/eye-off";
  import Loader from "lucide-svelte/icons/loader";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import ChevronRight from "lucide-svelte/icons/chevron-right";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let passphrase = $state("");
  let confirmPassphrase = $state("");
  let showPassphrase = $state(false);
  let selection = $state<ExportSelection>(defaultExportSelection());
  let advancedOpen = $state(false);
  let exporting = $state(false);
  let progressMessage = $state("");

  let passphraseMatch = $derived(
    !passphrase || passphrase === confirmPassphrase,
  );
  let nothingSelected = $derived(
    !selection.settings &&
      !selection.mlClassification &&
      !selection.accounts &&
      !selection.journal &&
      !selection.currencies &&
      !selection.exchangeRates &&
      !selection.budgets &&
      !selection.reconciliations &&
      !selection.sources &&
      !selection.rawTransactions &&
      !selection.plugins,
  );
  let canExport = $derived(
    !exporting && (!passphrase || passphraseMatch) && !nothingSelected,
  );

  function resetDialog() {
    passphrase = "";
    confirmPassphrase = "";
    showPassphrase = false;
    selection = defaultExportSelection();
    advancedOpen = false;
    exporting = false;
    progressMessage = "";
  }

  $effect(() => {
    if (open) resetDialog();
  });

  async function handleExport() {
    exporting = true;
    progressMessage = "Preparing export...";
    try {
      const backend = getBackend();
      const data = await exportData(
        backend,
        {
          passphrase: passphrase || undefined,
          selection,
        },
        (msg) => { progressMessage = msg; },
      );
      downloadExport(data, !!passphrase);
      const s = loadSettings();
      s.lastExportDate = new Date().toISOString();
      saveToStorage(s);
      toast.success("Export complete");
      open = false;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      exporting = false;
      progressMessage = "";
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Export data</Dialog.Title>
      <Dialog.Description>
        Export your data to a .dledger file. Optionally encrypt with a passphrase.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <!-- Passphrase -->
      <div class="space-y-2">
        <p class="text-sm font-medium">Passphrase (optional)</p>
        <div class="relative">
          <Input
            type={showPassphrase ? "text" : "password"}
            placeholder="Leave empty for unencrypted export"
            bind:value={passphrase}
            class="pr-10"
          />
          <button
            type="button"
            tabindex={-1}
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
        {#if passphrase}
          <Input
            type={showPassphrase ? "text" : "password"}
            placeholder="Confirm passphrase"
            bind:value={confirmPassphrase}
          />
          {#if confirmPassphrase && !passphraseMatch}
            <p class="text-xs text-destructive">Passphrases do not match</p>
          {/if}
        {/if}
      </div>

      <!-- Primary toggles -->
      <div class="space-y-3">
        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={selection.settings} />
          <span>Include settings</span>
        </label>

        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={selection.mlClassification} />
          <span>Include ML classification data</span>
        </label>
        {#if selection.mlClassification}
          <p class="text-xs text-muted-foreground ml-6 -mt-1">
            Carries categorization rules + distilled historical examples so future
            imports can classify like they had full history, even without transactions.
          </p>
        {/if}
      </div>

      <!-- Advanced -->
      <Collapsible.Root bind:open={advancedOpen}>
        <Collapsible.Trigger
          class="flex w-full items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {#if advancedOpen}
            <ChevronDown class="h-4 w-4" />
          {:else}
            <ChevronRight class="h-4 w-4" />
          {/if}
          Advanced
        </Collapsible.Trigger>
        <Collapsible.Content class="pt-3">
          <div class="space-y-4 border-l-2 border-muted pl-4">
            <!-- Ledger data -->
            <div class="space-y-2">
              <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ledger data</p>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.accounts} /> Accounts
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.journal} /> Journal entries
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.currencies} /> Currencies
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.exchangeRates} /> Exchange rates
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.budgets} /> Budgets
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.reconciliations} /> Reconciliations
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.sources} /> Sources (etherscan / bitcoin / CEX / chains)
              </label>
            </div>

            <!-- Optional -->
            <div class="space-y-2">
              <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Optional</p>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.rawTransactions} /> Raw transaction data
              </label>
              {#if selection.rawTransactions}
                <p class="text-xs text-muted-foreground ml-6 -mt-1">
                  Warning: can significantly increase file size.
                </p>
              {/if}
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.plugins} /> Custom plugins
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox bind:checked={selection.apiKeys} /> API keys (⚠ secrets)
              </label>
            </div>

            <!-- ML classification sub-toggles -->
            <div class="space-y-2">
              <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">ML classification</p>
              <label class="flex items-center gap-2 text-sm" class:opacity-50={!selection.mlClassification}>
                <Checkbox bind:checked={selection.mlRules} disabled={!selection.mlClassification} />
                Categorization rules
              </label>
              <label class="flex items-center gap-2 text-sm" class:opacity-50={!selection.mlClassification}>
                <Checkbox bind:checked={selection.mlExamples} disabled={!selection.mlClassification} />
                Distilled historical examples & tags
              </label>
              <label class="flex items-center gap-2 text-sm" class:opacity-50={!selection.mlClassification}>
                <Checkbox bind:checked={selection.mlSettings} disabled={!selection.mlClassification} />
                ML settings (threshold, enabled flag)
              </label>
            </div>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      {#if nothingSelected}
        <p class="text-xs text-destructive">
          Nothing selected — enable at least one category to export.
        </p>
      {/if}

      {#if exporting}
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader class="h-4 w-4 animate-spin" />
          <span>{progressMessage}</span>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => open = false} disabled={exporting}>
        Cancel
      </Button>
      <Button onclick={handleExport} disabled={!canExport}>
        {#if exporting}
          <Loader class="mr-1 h-4 w-4 animate-spin" />
          Exporting...
        {:else}
          <Download class="mr-1 h-4 w-4" />
          Export
        {/if}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
