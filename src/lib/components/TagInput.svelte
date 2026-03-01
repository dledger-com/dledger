<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { cn } from "$lib/utils.js";
  import { tagColor, normalizeTag } from "$lib/utils/tags.js";
  import X from "lucide-svelte/icons/x";
  import Plus from "lucide-svelte/icons/plus";

  let { tags, onchange, suggestions, class: className }: { tags: string[]; onchange: (tags: string[]) => void; suggestions?: string[]; class?: string } = $props();

  const listId = `tag-sug-${Math.random().toString(36).slice(2, 8)}`;
  const filteredSuggestions = $derived(
    suggestions?.filter((s) => !tags.includes(s)) ?? [],
  );

  let editing = $state(false);
  let inputValue = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  function addTag() {
    const normalized = normalizeTag(inputValue);
    if (normalized && !tags.includes(normalized)) {
      onchange([...tags, normalized]);
    }
    inputValue = "";
    editing = false;
  }

  function removeTag(tag: string) {
    onchange(tags.filter((t) => t !== tag));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Escape") {
      inputValue = "";
      editing = false;
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addTag();
    } else {
      editing = false;
    }
  }

  function startEditing() {
    editing = true;
    // Focus after Svelte renders the input
    setTimeout(() => inputEl?.focus(), 0);
  }
</script>

<div class={cn("flex flex-wrap items-center gap-1.5", className)}>
  {#each tags as tag (tag)}
    <Badge variant="outline" class={cn(tagColor(tag), "border-transparent text-[11px] px-1.5 py-0 gap-0.5")}>
      {tag}
      <button type="button" class="ml-0.5 hover:opacity-70 cursor-pointer" onclick={() => removeTag(tag)}>
        <X class="h-3 w-3" />
      </button>
    </Badge>
  {/each}

  {#if editing}
    <input
      bind:this={inputEl}
      bind:value={inputValue}
      list={listId}
      class="h-5 w-20 rounded border border-dashed border-muted-foreground/40 bg-transparent px-1.5 text-xs outline-none focus:border-primary"
      placeholder="tag"
      onkeydown={handleKeydown}
      onblur={handleBlur}
    />
    {#if filteredSuggestions.length > 0}
      <datalist id={listId}>
        {#each filteredSuggestions as s}
          <option value={s}></option>
        {/each}
      </datalist>
    {/if}
  {:else}
    <button
      type="button"
      class="flex h-5 items-center gap-0.5 rounded border border-dashed border-muted-foreground/40 px-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary cursor-pointer"
      onclick={startEditing}
    >
      <Plus class="h-3 w-3" />
    </button>
  {/if}
</div>
