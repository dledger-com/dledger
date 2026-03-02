<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { cn } from "$lib/utils.js";
  import { tagColor } from "$lib/utils/tags.js";

  let { tags, onclick, class: className }: { tags: string[]; onclick?: (tag: string) => void; class?: string } = $props();
</script>

{#if tags.length > 0}
  <div class={cn("flex flex-wrap gap-1", className)}>
    {#each tags as tag (tag)}
      {#if onclick}
        <button type="button" onclick={(e) => { e.preventDefault(); e.stopPropagation(); onclick(tag); }}>
          <Badge variant="outline" class={cn(tagColor(tag), "border-transparent text-[11px] px-1.5 py-0 cursor-pointer hover:opacity-80")}>
            {tag}
          </Badge>
        </button>
      {:else}
        <Badge variant="outline" class={cn(tagColor(tag), "border-transparent text-[11px] px-1.5 py-0")}>
          {tag}
        </Badge>
      {/if}
    {/each}
  </div>
{/if}
