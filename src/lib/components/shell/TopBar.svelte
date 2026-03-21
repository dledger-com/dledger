<script lang="ts">
  import { page } from "$app/state";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import EllipsisVertical from "lucide-svelte/icons/ellipsis-vertical";
  import TaskQueueIndicator from "./TaskQueueIndicator.svelte";
  import TaskQueueDrawer from "./TaskQueueDrawer.svelte";
  import ReprocessPreviewDialog from "./ReprocessPreviewDialog.svelte";
  import { getBreadcrumbOverrides } from "$lib/data/breadcrumb.svelte.js";
  import { getTopBarActions, type PageAction } from "$lib/data/page-actions.svelte.js";
  import * as m from "$paraglide/messages.js";

  interface Props {
    showSidebarTrigger?: boolean;
  }

  let { showSidebarTrigger = true }: Props = $props();
  let drawerOpen = $state(false);

  const segmentLabels: Record<string, () => string> = {
    accounts: () => m.nav_accounts(),
    journal: () => m.nav_journal(),
    reports: () => m.nav_reports(),
    budgets: () => m.nav_budgets(),
    currencies: () => m.nav_currencies(),
    sources: () => m.nav_sources(),
    settings: () => m.nav_settings(),
  };

  const breadcrumbs = $derived.by(() => {
    const path = page.url?.pathname ?? "/";
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return [{ label: m.nav_dashboard(), href: "/" }];
    const overrides = getBreadcrumbOverrides();
    return segments.map((seg, i) => ({
      label: overrides.get(seg) ?? segmentLabels[seg]?.() ?? seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " "),
      href: "/" + segments.slice(0, i + 1).join("/"),
    }));
  });

  const actions = $derived(getTopBarActions());
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
    {#each actions as action}
      {#if action.type === 'button'}
        <Button
          size="sm"
          variant={action.variant ?? 'default'}
          href={action.href}
          onclick={action.onclick}
          disabled={action.disabled}
          class={action.fab ? 'hidden md:inline-flex' : ''}
        >
          {action.label}
        </Button>
      {:else if action.type === 'menu'}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button variant="outline" size="icon-sm" {...props}>
                <EllipsisVertical class="h-4 w-4" />
                <span class="sr-only">{m.nav_more_actions()}</span>
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {#each action.items as item}
              {#if item.separator}
                <DropdownMenu.Separator />
              {:else if item.header}
                <DropdownMenu.Item disabled class="text-xs font-medium opacity-70">{item.label}</DropdownMenu.Item>
              {:else}
                <DropdownMenu.Item disabled={item.disabled} onclick={item.onclick}>
                  {item.label}
                </DropdownMenu.Item>
              {/if}
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    {/each}
    <TaskQueueIndicator onclick={() => { drawerOpen = true; }} />
  </div>
</header>

{#each actions as action}
  {#if action.type === 'button' && action.fab}
    {@const FabIcon = action.fabIcon}
    <Button
      size="icon"
      variant={action.variant ?? 'default'}
      href={action.href}
      onclick={action.onclick}
      class="fixed bottom-20 right-4 z-50 rounded-full shadow-lg md:hidden size-12 [&_svg]:size-5"
      aria-label={action.label}
    >
      {#if FabIcon}
        <FabIcon />
      {/if}
    </Button>
  {/if}
{/each}

<TaskQueueDrawer bind:open={drawerOpen} />
<ReprocessPreviewDialog />
