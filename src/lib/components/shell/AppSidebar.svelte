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
  import PiggyBank from "lucide-svelte/icons/piggy-bank";
  import Coins from "lucide-svelte/icons/coins";
  import Link2 from "lucide-svelte/icons/link-2";

  const versionLabel = dev ? `v${__APP_VERSION__}-${__GIT_HASH__}` : `v${__APP_VERSION__}`;

  const navItems = [
    { title: "Dashboard", href: "/", icon: LayoutDashboard },
    { title: "Accounts", href: "/accounts", icon: BookOpen },
    { title: "Journal", href: "/journal", icon: FileText },
    { title: "Links", href: "/links", icon: Link2 },
    { title: "Reports", href: "/reports", icon: BarChart3 },
    { title: "Budgets", href: "/budgets", icon: PiggyBank },
    { title: "Currencies", href: "/currencies", icon: Coins },
    { title: "Sources", href: "/sources", icon: ArrowUpDown },
    { title: "Settings", href: "/settings", icon: Settings },
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
      <Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each navItems as item (item.title)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton>
                {#snippet child({ props })}
                  <a
                    href={item.href}
                    {...props}
                    data-active={isActive(item.href) ? "" : undefined}
                  >
                    <item.icon class="h-4 w-4" />
                    <span>{item.title}</span>
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
    <div class="px-2 py-1 text-xs text-muted-foreground">
      dLedger {versionLabel}
    </div>
  </Sidebar.Footer>
  <Sidebar.Rail />
</Sidebar.Root>
