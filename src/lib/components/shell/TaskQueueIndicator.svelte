<script lang="ts">
  import { taskQueue } from "$lib/task-queue.svelte.js";
  import Loader from "lucide-svelte/icons/loader";
  import AlertTriangle from "lucide-svelte/icons/triangle-alert";
  import ListTodo from "lucide-svelte/icons/list-todo";
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    onclick: () => void;
  }

  let { onclick }: Props = $props();

  const visible = $derived(taskQueue.queue.length > 0);
  const hasActive = $derived(taskQueue.activeCount > 0);
  const hasActions = $derived(!hasActive && taskQueue.actionCount > 0);
  const hasErrors = $derived(!hasActive && !hasActions && taskQueue.hasErrors);
</script>

{#if visible}
  <Button variant="ghost" size="icon" class="relative h-8 w-8" {onclick}>
    {#if hasActive}
      <Loader class="h-4 w-4 animate-spin" />
      <span
        class="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
      >
        {taskQueue.activeCount}
      </span>
    {:else if hasActions}
      <ListTodo class="h-4 w-4 text-amber-500" />
      <span
        class="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-medium text-white"
      >
        {taskQueue.actionCount}
      </span>
    {:else if hasErrors}
      <AlertTriangle class="h-4 w-4 text-amber-500" />
    {:else}
      <ListTodo class="h-4 w-4 text-muted-foreground" />
    {/if}
  </Button>
{/if}
