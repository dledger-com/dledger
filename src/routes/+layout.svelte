<script lang="ts">
  import "../app.css";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { initBackend } from "$lib/backend.js";
  import { onMount } from "svelte";

  let { children } = $props();

  let ready = $state(false);

  onMount(async () => {
    try {
      await initBackend();
      ready = true;
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
