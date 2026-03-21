<script lang="ts">
  import { page } from "$app/state";
  import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
  import BookOpen from "lucide-svelte/icons/book-open";
  import FileText from "lucide-svelte/icons/file-text";
  import BarChart3 from "lucide-svelte/icons/bar-chart-3";
  import Ellipsis from "lucide-svelte/icons/ellipsis";
  import * as m from "$paraglide/messages.js";

  const tabs = [
    { title: () => m.nav_dashboard(), href: "/", icon: LayoutDashboard },
    { title: () => m.nav_accounts(), href: "/accounts", icon: BookOpen },
    { title: () => m.nav_journal(), href: "/journal", icon: FileText },
    { title: () => m.nav_reports(), href: "/reports", icon: BarChart3 },
    { title: () => m.nav_more(), href: "/settings", icon: Ellipsis },
  ];

  function isActive(href: string): boolean {
    const pathname = page.url?.pathname ?? "/";
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }
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
</nav>
