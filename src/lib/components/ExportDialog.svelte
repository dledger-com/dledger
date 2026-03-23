<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { getBackend } from "$lib/backend.js";
  import { exportData, downloadExport } from "$lib/export/export.js";
  import { toast } from "svelte-sonner";
  import Download from "lucide-svelte/icons/download";
  import Eye from "lucide-svelte/icons/eye";
  import EyeOff from "lucide-svelte/icons/eye-off";
  import Loader from "lucide-svelte/icons/loader";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let passphrase = $state("");
  let confirmPassphrase = $state("");
  let showPassphrase = $state(false);
  let includeRaw = $state(false);
  let includeApiKeys = $state(false);
  let includeSettings = $state(true);
  let exporting = $state(false);
  let progressMessage = $state("");

  let passphraseMatch = $derived(
    !passphrase || passphrase === confirmPassphrase,
  );
  let canExport = $derived(
    !exporting && (!passphrase || passphraseMatch),
  );

  function resetDialog() {
    passphrase = "";
    confirmPassphrase = "";
    showPassphrase = false;
    includeRaw = false;
    includeApiKeys = false;
    includeSettings = true;
    exporting = false;
    progressMessage = "";
  }

  $effect(() => {
    if (open) {
      resetDialog();
    }
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
          includeRawTransactions: includeRaw,
          includeApiKeys,
          includeSettings,
        },
        (msg) => { progressMessage = msg; },
      );
      downloadExport(data, !!passphrase);
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
  <Dialog.Content class="sm:max-w-[480px]">
    <Dialog.Header>
      <Dialog.Title>Export data</Dialog.Title>
      <Dialog.Description>
        Export all your data to a .dledger file. Optionally encrypt with a passphrase.
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

      <!-- Options -->
      <div class="space-y-3">
        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={includeSettings} />
          Include settings
        </label>

        <label class="flex items-center gap-2 text-sm">
          <Checkbox bind:checked={includeApiKeys} />
          Include API keys
        </label>

        <div>
          <label class="flex items-center gap-2 text-sm">
            <Checkbox bind:checked={includeRaw} />
            Include raw transaction data
          </label>
          {#if includeRaw}
            <p class="text-xs text-muted-foreground ml-6 mt-1">
              Warning: raw transaction data can significantly increase file size.
            </p>
          {/if}
        </div>
      </div>

      <!-- Progress -->
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
