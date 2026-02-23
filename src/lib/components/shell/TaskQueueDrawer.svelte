<script lang="ts">
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { taskQueue, type QueuedTask } from "$lib/task-queue.svelte.js";
  import CircleCheck from "lucide-svelte/icons/circle-check";
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import CircleX from "lucide-svelte/icons/circle-x";
  import Ban from "lucide-svelte/icons/ban";
  import X from "lucide-svelte/icons/x";
  import Loader from "lucide-svelte/icons/loader";
  import ListTodo from "lucide-svelte/icons/list-todo";

  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  let isMobile = $state(false);

  $effect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    isMobile = mq.matches;
    const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  let elapsed = $state(0);
  let intervalId: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    const running = taskQueue.running;
    if (running.length > 0 && running[0].startedAt) {
      elapsed = Math.floor((Date.now() - running[0].startedAt) / 1000);
      intervalId = setInterval(() => {
        const task = taskQueue.running[0];
        if (task?.startedAt) {
          elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
        }
      }, 1000);
    } else {
      elapsed = 0;
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  });

  function formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  function progressPercent(task: QueuedTask): number | null {
    if (!task.progress || task.progress.total <= 0) return null;
    return Math.min(100, Math.round((task.progress.current / task.progress.total) * 100));
  }
</script>

<Drawer.Root bind:open direction={isMobile ? 'bottom' : 'right'}>
  <Drawer.Content class={isMobile ? '' : 'sm:max-w-[400px]'}>
    <Drawer.Header>
      <Drawer.Title>Background Tasks</Drawer.Title>
    </Drawer.Header>

    <div class="flex-1 overflow-y-auto px-1">
      {#if taskQueue.queue.length === 0}
        <div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <ListTodo class="mb-2 h-8 w-8" />
          <p class="text-sm">No background tasks</p>
        </div>
      {:else}
        <!-- Running -->
        {#each taskQueue.running as task (task.id)}
          <div class="mb-3 rounded-lg border p-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Loader class="h-4 w-4 animate-spin text-primary" />
                <span class="text-sm font-medium">{task.label}</span>
              </div>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={() => taskQueue.cancel(task.id)}>
                Cancel
              </Button>
            </div>
            {#if task.description}
              <p class="mt-1 text-xs text-muted-foreground">{task.description}</p>
            {/if}
            {#if task.progress}
              {@const pct = progressPercent(task)}
              {#if pct !== null}
                <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full bg-primary transition-all duration-300"
                    style="width: {pct}%"
                  ></div>
                </div>
                <p class="mt-1 text-xs text-muted-foreground">
                  {task.progress.current} / {task.progress.total}
                  {#if task.progress.message}&mdash; {task.progress.message}{/if}
                </p>
              {:else if task.progress.message}
                <p class="mt-2 text-xs text-muted-foreground">{task.progress.message}</p>
              {/if}
            {/if}
            <p class="mt-1 text-xs text-muted-foreground">Elapsed: {formatElapsed(elapsed)}</p>
          </div>
        {/each}

        <!-- Pending -->
        {#if taskQueue.pending.length > 0}
          <h4 class="mb-1 mt-3 text-xs font-medium text-muted-foreground uppercase">Queued</h4>
          {#each taskQueue.pending as task (task.id)}
            <div class="mb-2 flex items-center justify-between rounded-lg border p-2">
              <span class="text-sm">{task.label}</span>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={() => taskQueue.cancel(task.id)}>
                <X class="h-3 w-3" />
              </Button>
            </div>
          {/each}
        {/if}

        <!-- History -->
        {#if taskQueue.history.length > 0}
          <div class="mt-3 flex items-center justify-between">
            <h4 class="text-xs font-medium text-muted-foreground uppercase">History</h4>
            <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={() => taskQueue.clearHistory()}>
              Clear
            </Button>
          </div>
          {#each taskQueue.history as task (task.id)}
            <div class="group mb-2 flex items-start gap-2 rounded-lg border p-2">
              {#if task.status === "completed" && task.result?.actionRequired}
                <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              {:else if task.status === "completed"}
                <CircleCheck class="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
              {:else if task.status === "failed"}
                <CircleX class="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              {:else}
                <Ban class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              {/if}
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium">{task.label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                    onclick={() => taskQueue.dismiss(task.id)}
                  >
                    <X class="h-3 w-3" />
                  </Button>
                </div>
                {#if task.status === "completed" && task.result?.summary}
                  <p class="text-xs text-muted-foreground">{task.result.summary}</p>
                {:else if task.status === "failed" && task.error}
                  <p class="text-xs text-red-500">{task.error}</p>
                {:else if task.status === "cancelled"}
                  <p class="text-xs text-muted-foreground">Cancelled</p>
                {/if}
                {#if task.status === "completed" && task.result?.actionRequired}
                  <Button
                    size="sm"
                    class="mt-1 h-6 text-xs"
                    onclick={() => { open = false; taskQueue.handleAction(task.id); }}
                  >
                    {task.result.actionLabel ?? "Review"}
                  </Button>
                {/if}
                {#if task.finishedAt}
                  <p class="text-xs text-muted-foreground">{formatTime(task.finishedAt)}</p>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
