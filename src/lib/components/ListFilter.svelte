<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import Search from "lucide-svelte/icons/search";
  import X from "lucide-svelte/icons/x";
  import * as m from "$paraglide/messages.js";

  interface Props {
    value: string;
    placeholder?: string;
    class?: string;
  }

  let { value = $bindable(""), placeholder = "Filter...", class: className }: Props = $props();
</script>

<div class="relative w-full sm:w-auto sm:max-w-sm {className ?? ''}">
  <Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
  <Input type="text" {placeholder} bind:value class="pl-9 pr-9" aria-label={placeholder}
    onkeydown={(e) => { if (e.key === 'Escape') value = ''; }} />
  {#if value}
    <button type="button" onclick={() => (value = "")} aria-label={m.filter_clear()}
      class="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
      <X class="size-4" />
    </button>
  {/if}
</div>
