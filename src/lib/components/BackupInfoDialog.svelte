<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as m from "$paraglide/messages.js";
  import CloudOff from "lucide-svelte/icons/cloud-off";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import ShieldAlert from "lucide-svelte/icons/shield-alert";
  import Download from "lucide-svelte/icons/download";

  let {
    open = $bindable(false),
    onexport,
  }: {
    open: boolean;
    onexport?: () => void;
  } = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[440px]">
    <Dialog.Header>
      <Dialog.Title>{m.dialog_backup_title()}</Dialog.Title>
      <Dialog.Description>{m.dialog_backup_description()}</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-2">
      <div class="flex gap-3">
        <CloudOff class="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <p class="text-sm">{m.dialog_backup_no_sync()}</p>
      </div>
      <div class="flex gap-3">
        <Trash2 class="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <p class="text-sm">{m.dialog_backup_ephemeral()}</p>
      </div>
      <div class="flex gap-3">
        <ShieldAlert class="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <p class="text-sm">{m.dialog_backup_recommendation()}</p>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>
        {m.btn_close()}
      </Button>
      <Button
        onclick={() => {
          onexport?.();
          open = false;
        }}
      >
        <Download class="mr-1 h-4 w-4" />
        {m.dialog_backup_export_now()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
