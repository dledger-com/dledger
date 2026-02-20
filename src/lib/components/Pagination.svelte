<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import ChevronLeft from "lucide-svelte/icons/chevron-left";
  import ChevronRight from "lucide-svelte/icons/chevron-right";

  interface Props {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  }

  let { currentPage, totalPages, onPageChange }: Props = $props();
</script>

{#if totalPages > 1}
  <div class="flex items-center justify-center gap-2">
    <Button
      variant="outline"
      size="sm"
      disabled={currentPage <= 1}
      onclick={() => onPageChange(currentPage - 1)}
    >
      <ChevronLeft class="size-4" />
      Previous
    </Button>
    <span class="text-sm text-muted-foreground">
      Page {currentPage} of {totalPages}
    </span>
    <Button
      variant="outline"
      size="sm"
      disabled={currentPage >= totalPages}
      onclick={() => onPageChange(currentPage + 1)}
    >
      Next
      <ChevronRight class="size-4" />
    </Button>
  </div>
{/if}
