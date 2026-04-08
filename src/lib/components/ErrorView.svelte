<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { page } from "$app/state";
  import * as m from "$paraglide/messages.js";

  const status = $derived(page.status);
  const isNotFound = $derived(status === 404);
  const title = $derived(isNotFound ? m.error_404_title() : m.error_generic_title());
  const description = $derived(
    isNotFound
      ? m.error_404_description()
      : (page.error?.message ?? m.error_generic_description()),
  );
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center min-h-[60vh]">
  <div class="text-7xl font-bold text-muted-foreground/40 tabular-nums select-none">
    {status}
  </div>
  <div class="space-y-2 max-w-md">
    <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
    <p class="text-sm text-muted-foreground">{description}</p>
  </div>
  <Button href="/">{m.btn_back_to_dashboard()}</Button>
</div>
