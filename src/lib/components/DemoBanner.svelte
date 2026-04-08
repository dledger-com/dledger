<script lang="ts">
  // Read-only demo mode banner. Mounted at the top of (app)/+layout.svelte
  // when DEMO_MODE is true. Tree-shaken out of regular builds.
  import ExternalLink from "lucide-svelte/icons/external-link";
  import * as m from "$paraglide/messages.js";
</script>

<div
  role="status"
  aria-live="polite"
  class="flex h-9 shrink-0 items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 text-xs sm:text-sm dark:bg-amber-500/15"
>
  <span
    class="inline-flex h-5 shrink-0 items-center rounded-full bg-amber-500/25 px-2 text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-200"
  >
    Demo
  </span>
  <span class="truncate text-foreground/85">
    {m.demo_banner_message()}
  </span>
  <a
    href="https://dledger.com"
    target="_blank"
    rel="noopener noreferrer"
    class="hidden shrink-0 items-center gap-1 font-medium text-amber-800 hover:underline sm:inline-flex dark:text-amber-200"
  >
    {m.demo_banner_cta()}
    <ExternalLink class="size-3" />
  </a>
</div>
