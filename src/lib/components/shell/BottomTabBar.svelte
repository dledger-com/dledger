<script lang="ts">
  import { page } from "$app/state";
  import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
  import BookOpen from "lucide-svelte/icons/book-open";
  import FileText from "lucide-svelte/icons/file-text";
  import BarChart3 from "lucide-svelte/icons/bar-chart-3";
  import Ellipsis from "lucide-svelte/icons/ellipsis";

  const tabs = [
    { title: "Dashboard", href: "/", icon: LayoutDashboard },
    { title: "Accounts", href: "/accounts", icon: BookOpen },
    { title: "Journal", href: "/journal", icon: FileText },
    { title: "Reports", href: "/reports", icon: BarChart3 },
    { title: "More", href: "/settings", icon: Ellipsis },
  ];

  function isActive(href: string): boolean {
    const pathname = page.url?.pathname ?? "/";
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }
</script>

<nav class="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center justify-around border-t bg-background md:hidden">
  {#each tabs as tab (tab.title)}
    <a
      href={tab.href}
      class="flex flex-1 flex-col items-center gap-0.5 py-1 text-xs transition-colors {isActive(tab.href)
        ? 'text-primary'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <tab.icon class="h-5 w-5" />
      <span>{tab.title}</span>
    </a>
  {/each}
</nav>
