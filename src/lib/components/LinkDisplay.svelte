<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { cn } from "$lib/utils.js";
  import { linkColor } from "$lib/utils/links.js";
  import Link2 from "lucide-svelte/icons/link-2";

  let { links, onclick, class: className }: { links: string[]; onclick?: (link: string) => void; class?: string } = $props();
</script>

{#if links.length > 0}
  <div class={cn("flex flex-wrap gap-1", className)}>
    {#each links as link (link)}
      {#if onclick}
        <button type="button" onclick={(e) => { e.preventDefault(); e.stopPropagation(); onclick(link); }}>
          <Badge variant="outline" class={cn(linkColor(link), "border-transparent text-[11px] px-1.5 py-0 gap-0.5 cursor-pointer hover:opacity-80")}>
            <Link2 class="h-2.5 w-2.5" />
            {link}
          </Badge>
        </button>
      {:else}
        <a href="/journal?q={encodeURIComponent('^' + link)}">
          <Badge variant="outline" class={cn(linkColor(link), "border-transparent text-[11px] px-1.5 py-0 gap-0.5 cursor-pointer hover:opacity-80")}>
            <Link2 class="h-2.5 w-2.5" />
            {link}
          </Badge>
        </a>
      {/if}
    {/each}
  </div>
{/if}
