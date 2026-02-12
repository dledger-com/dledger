<script lang="ts">
  import { page } from "$app/state";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import ThemeToggle from "./ThemeToggle.svelte";

  interface Props {
    showSidebarTrigger?: boolean;
  }

  let { showSidebarTrigger = true }: Props = $props();

  const breadcrumbs = $derived.by(() => {
    const path = page.url?.pathname ?? "/";
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return [{ label: "Dashboard", href: "/" }];
    return segments.map((seg, i) => ({
      label: seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " "),
      href: "/" + segments.slice(0, i + 1).join("/"),
    }));
  });
</script>

<header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
  {#if showSidebarTrigger}
    <Sidebar.Trigger class="-ml-1" />
    <Separator orientation="vertical" class="mr-2 !h-4" />
  {/if}

  <nav class="flex items-center gap-1 text-sm">
    {#each breadcrumbs as crumb, i}
      {#if i > 0}
        <span class="text-muted-foreground">/</span>
      {/if}
      {#if i === breadcrumbs.length - 1}
        <span class="font-medium">{crumb.label}</span>
      {:else}
        <a href={crumb.href} class="text-muted-foreground hover:text-foreground">
          {crumb.label}
        </a>
      {/if}
    {/each}
  </nav>

  <div class="ml-auto flex items-center gap-2">
    <ThemeToggle />
  </div>
</header>
