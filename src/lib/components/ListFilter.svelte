<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import Search from "lucide-svelte/icons/search";
  import X from "lucide-svelte/icons/x";

  interface Props {
    value: string;
    placeholder?: string;
    class?: string;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(""), placeholder = "Filter...", class: className, onchange }: Props = $props();
</script>

<div class="relative w-full sm:w-auto sm:max-w-sm {className ?? ''}">
  <Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
  <Input type="text" {placeholder} bind:value class="pl-9 pr-9"
    oninput={(e) => { onchange?.(e.currentTarget.value); }}
    onkeydown={(e) => { if (e.key === 'Escape') { value = ''; onchange?.(''); } }} />
  {#if value}
    <button type="button" onclick={() => { value = ""; onchange?.(''); }}
      class="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
      <X class="size-4" />
    </button>
  {/if}
</div>
