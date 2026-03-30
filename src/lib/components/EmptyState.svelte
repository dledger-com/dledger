<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    message: string;
    action?: Snippet;
  }

  let { message, action }: Props = $props();
</script>

<div class="flex flex-col items-center gap-3 py-8">
  <p class="text-sm text-muted-foreground text-center">{message}</p>
  {#if action}
    {@render action()}
  {/if}
</div>
