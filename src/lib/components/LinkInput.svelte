<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { cn } from "$lib/utils.js";
  import { linkColor, normalizeLink } from "$lib/utils/links.js";
  import Link2 from "lucide-svelte/icons/link-2";
  import X from "lucide-svelte/icons/x";
  import Plus from "lucide-svelte/icons/plus";

  let { links, onchange, suggestions, class: className }: { links: string[]; onchange: (links: string[]) => void; suggestions?: string[]; class?: string } = $props();

  const listId = `link-sug-${Math.random().toString(36).slice(2, 8)}`;
  const filteredSuggestions = $derived(
    suggestions?.filter((s) => !links.includes(s)) ?? [],
  );

  let editing = $state(false);
  let inputValue = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  function addLink() {
    const normalized = normalizeLink(inputValue);
    if (normalized && !links.includes(normalized)) {
      onchange([...links, normalized]);
    }
    inputValue = "";
    editing = false;
  }

  function removeLink(link: string) {
    onchange(links.filter((l) => l !== link));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addLink();
    } else if (e.key === "Escape") {
      inputValue = "";
      editing = false;
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addLink();
    } else {
      editing = false;
    }
  }

  function startEditing() {
    editing = true;
    setTimeout(() => inputEl?.focus(), 0);
  }
</script>

<div class={cn("flex flex-wrap items-center gap-1.5", className)}>
  {#each links as link (link)}
    <Badge variant="outline" class={cn(linkColor(link), "border-transparent text-[11px] px-1.5 py-0 gap-0.5")}>
      <Link2 class="h-2.5 w-2.5" />
      {link}
      <button type="button" class="relative ml-0.5 hover:opacity-70 cursor-pointer after:absolute after:-inset-2" onclick={() => removeLink(link)} aria-label="Remove link {link}">
        <X class="h-3 w-3" />
      </button>
    </Badge>
  {/each}

  {#if editing}
    <input
      bind:this={inputEl}
      bind:value={inputValue}
      list={listId}
      class="h-5 w-20 rounded border border-dashed border-muted-foreground/40 bg-transparent px-1.5 text-xs outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-1"
      placeholder="link"
      aria-label="New link"
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
      aria-label="Add link"
    >
      <Plus class="h-3 w-3" />
    </button>
  {/if}
</div>
