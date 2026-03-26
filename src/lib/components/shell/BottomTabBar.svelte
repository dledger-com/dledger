<script lang="ts">
  import { page } from "$app/state";
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
  import BookOpen from "lucide-svelte/icons/book-open";
  import FileText from "lucide-svelte/icons/file-text";
  import BarChart3 from "lucide-svelte/icons/bar-chart-3";
  import Coins from "lucide-svelte/icons/coins";
  import PiggyBank from "lucide-svelte/icons/piggy-bank";
  import ArrowUpDown from "lucide-svelte/icons/arrow-up-down";
  import Settings from "lucide-svelte/icons/settings";
  import MessageCircleQuestion from "lucide-svelte/icons/message-circle-question";
  import Ellipsis from "lucide-svelte/icons/ellipsis";
  import * as m from "$paraglide/messages.js";

  let {
    onfeedback,
  }: {
    onfeedback?: () => void;
  } = $props();

  const tabs = [
    { title: () => m.nav_dashboard_short(), href: "/", icon: LayoutDashboard },
    { title: () => m.nav_accounts(), href: "/accounts", icon: BookOpen },
    { title: () => m.nav_journal(), href: "/journal", icon: FileText },
    { title: () => m.nav_reports(), href: "/reports", icon: BarChart3 },
  ];

  const moreItems = [
    { title: () => m.nav_currencies(), href: "/currencies", icon: Coins },
    { title: () => m.nav_budgets(), href: "/budgets", icon: PiggyBank },
    { title: () => m.nav_sources(), href: "/sources", icon: ArrowUpDown },
  ];

  let moreOpen = $state(false);

  function isActive(href: string): boolean {
    const pathname = page.url?.pathname ?? "/";
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  const moreActive = $derived(moreItems.some((i) => isActive(i.href)) || isActive("/settings"));
</script>

<nav class="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center justify-around border-t bg-background md:hidden">
  {#each tabs as tab (tab.href)}
    <a
      href={tab.href}
      class="flex flex-1 flex-col items-center gap-0.5 py-1 text-xs transition-colors {isActive(tab.href)
        ? 'text-primary'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <tab.icon class="h-5 w-5" />
      <span>{tab.title()}</span>
    </a>
  {/each}
  <button
    type="button"
    onclick={() => { moreOpen = true; }}
    class="flex flex-1 flex-col items-center gap-0.5 py-1 text-xs transition-colors cursor-pointer {moreActive
      ? 'text-primary'
      : 'text-muted-foreground hover:text-foreground'}"
  >
    <Ellipsis class="h-5 w-5" />
    <span>{m.nav_more()}</span>
  </button>
</nav>

<Drawer.Root bind:open={moreOpen} direction="bottom">
  <Drawer.Portal>
    <Drawer.Overlay />
    <Drawer.Content>
      <Drawer.Header class="sr-only">
        <Drawer.Title>{m.nav_more()}</Drawer.Title>
      </Drawer.Header>
      <div class="px-2 pb-6 pt-2">
        {#each moreItems as item (item.href)}
          <a
            href={item.href}
            onclick={() => { moreOpen = false; }}
            class="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors {isActive(item.href)
              ? 'text-primary bg-primary/5'
              : 'text-foreground hover:bg-accent'}"
          >
            <item.icon class="h-5 w-5" />
            {item.title()}
          </a>
        {/each}
        <div class="my-1 border-t"></div>
        <a
          href="/settings"
          onclick={() => { moreOpen = false; }}
          class="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors {isActive('/settings')
            ? 'text-primary bg-primary/5'
            : 'text-foreground hover:bg-accent'}"
        >
          <Settings class="h-5 w-5" />
          {m.nav_settings()}
        </a>
        <button
          type="button"
          onclick={() => { moreOpen = false; onfeedback?.(); }}
          class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors text-foreground hover:bg-accent cursor-pointer"
        >
          <MessageCircleQuestion class="h-5 w-5" />
          {m.feedback_title()}
        </button>
      </div>
    </Drawer.Content>
  </Drawer.Portal>
</Drawer.Root>
