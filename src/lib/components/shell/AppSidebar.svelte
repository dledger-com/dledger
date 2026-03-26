<script lang="ts">
  import { dev } from "$app/environment";
  import { page } from "$app/state";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
  import BookOpen from "lucide-svelte/icons/book-open";
  import FileText from "lucide-svelte/icons/file-text";
  import BarChart3 from "lucide-svelte/icons/bar-chart-3";
  import ArrowUpDown from "lucide-svelte/icons/arrow-up-down";
  import Settings from "lucide-svelte/icons/settings";
  import MessageCircleQuestion from "lucide-svelte/icons/message-circle-question";
  import PiggyBank from "lucide-svelte/icons/piggy-bank";
  import Coins from "lucide-svelte/icons/coins";
  import ThemeToggle from "./ThemeToggle.svelte";
  import * as m from "$paraglide/messages.js";

  let {
    onfeedback,
  }: {
    onfeedback?: () => void;
  } = $props();

  const versionLabel = dev ? `v${__APP_VERSION__}-${__GIT_HASH__}` : `v${__APP_VERSION__}`;

  const navItems = [
    { title: () => m.nav_dashboard(), href: "/", icon: LayoutDashboard },
    { title: () => m.nav_accounts(), href: "/accounts", icon: BookOpen },
    { title: () => m.nav_journal(), href: "/journal", icon: FileText },
    { title: () => m.nav_currencies(), href: "/currencies", icon: Coins },
    { title: () => m.nav_budgets(), href: "/budgets", icon: PiggyBank },
    { title: () => m.nav_reports(), href: "/reports", icon: BarChart3 },
    { title: () => m.nav_sources(), href: "/sources", icon: ArrowUpDown },
  ];

  function isActive(href: string): boolean {
    const pathname = page.url?.pathname ?? "/";
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <div class="flex items-center gap-2 px-2 py-1">
      <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
        dL
      </div>
      <span class="font-semibold text-sm">dLedger</span>
    </div>
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.GroupLabel>{m.nav_navigation()}</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each navItems as item (item.href)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton>
                {#snippet child({ props })}
                  <a
                    href={item.href}
                    {...props}
                    data-active={isActive(item.href) ? "true" : undefined}
                  >
                    <item.icon class="h-4 w-4" />
                    <span>{item.title()}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <Sidebar.Footer>
    <div class="flex items-center justify-between px-2 py-1">
      <span class="text-xs text-muted-foreground">dLedger {versionLabel}</span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
          onclick={() => onfeedback?.()}
        >
          <MessageCircleQuestion class="h-4 w-4" />
        </button>
        <a
          href="/settings"
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
          class:text-foreground={isActive("/settings")}
        >
          <Settings class="h-4 w-4" />
        </a>
        <ThemeToggle />
      </div>
    </div>
  </Sidebar.Footer>
  <Sidebar.Rail />
</Sidebar.Root>
