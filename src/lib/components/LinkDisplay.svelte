<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { cn } from "$lib/utils.js";
  import { linkColor } from "$lib/utils/links.js";
  import Link2 from "lucide-svelte/icons/link-2";

  let { links, class: className }: { links: string[]; class?: string } = $props();
</script>

{#if links.length > 0}
  <div class={cn("flex flex-wrap gap-1", className)}>
    {#each links as link (link)}
      <a href="/links/{encodeURIComponent(link)}">
        <Badge variant="outline" class={cn(linkColor(link), "border-transparent text-[11px] px-1.5 py-0 gap-0.5 cursor-pointer hover:opacity-80")}>
          <Link2 class="h-2.5 w-2.5" />
          {link}
        </Badge>
      </a>
    {/each}
  </div>
{/if}
