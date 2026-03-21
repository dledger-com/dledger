<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { TAGS_META_KEY, NOTE_META_KEY } from "$lib/utils/tags.js";
  import X from "lucide-svelte/icons/x";
  import Plus from "lucide-svelte/icons/plus";

  let {
    metadata,
    onchange,
    keySuggestions,
    class: className,
  }: {
    metadata: Record<string, string>;
    onchange: (metadata: Record<string, string>) => void;
    keySuggestions?: string[];
    class?: string;
  } = $props();

  const listId = `meta-key-${Math.random().toString(36).slice(2, 8)}`;

  let newKey = $state("");
  let newValue = $state("");

  /** Entries excluding tags (managed separately via TagInput). */
  const entries = $derived(
    Object.entries(metadata).filter(([k]) => k !== TAGS_META_KEY && k !== NOTE_META_KEY),
  );

  function addEntry() {
    const key = newKey.trim();
    const value = newValue.trim();
    if (!key || !value) return;
    onchange({ ...metadata, [key]: value });
    newKey = "";
    newValue = "";
  }

  function removeEntry(key: string) {
    const next = { ...metadata };
    delete next[key];
    onchange(next);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addEntry();
    }
  }
</script>

<div class={className}>
  {#if entries.length > 0}
    <div class="space-y-1">
      {#each entries as [key, value] (key)}
        <div class="flex items-center gap-1.5 text-xs">
          <span class="font-medium text-muted-foreground min-w-[60px]">{key}</span>
          <span class="text-muted-foreground">:</span>
          <span class="flex-1 truncate">{value}</span>
          <button
            type="button"
            class="shrink-0 text-muted-foreground hover:text-destructive cursor-pointer"
            onclick={() => removeEntry(key)}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="flex items-center gap-1.5 mt-1">
    <Input
      bind:value={newKey}
      list={listId}
      placeholder="key"
      class="h-6 text-xs flex-1"
      onkeydown={handleKeydown}
    />
    <span class="text-muted-foreground text-xs">:</span>
    <Input
      bind:value={newValue}
      placeholder="value"
      class="h-6 text-xs flex-1"
      onkeydown={handleKeydown}
    />
    <button
      type="button"
      class="flex h-5 items-center gap-0.5 rounded border border-dashed border-muted-foreground/40 px-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary cursor-pointer"
      onclick={addEntry}
      disabled={!newKey.trim() || !newValue.trim()}
    >
      <Plus class="h-3 w-3" />
    </button>
  </div>
  {#if keySuggestions && keySuggestions.length > 0}
    <datalist id={listId}>
      {#each keySuggestions as s}
        <option value={s}></option>
      {/each}
    </datalist>
  {/if}
</div>
