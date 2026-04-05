export interface TaskDefinition {
  key: string;
  label: string;
  description?: string;
  concurrencyGroup?: string;
  run: (ctx: TaskContext) => Promise<TaskResult | void>;
  onAction?: (task: QueuedTask) => void;
}

export interface TaskContext {
  signal: AbortSignal;
  reportProgress: (progress: TaskProgress) => void;
}

export interface TaskProgress {
  current: number;
  total: number;
  message?: string;
}

export interface TaskResult {
  summary: string;
  data?: unknown;
  actionRequired?: boolean;
  actionLabel?: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface QueuedTask {
  id: string;
  key: string;
  label: string;
  description?: string;
  concurrencyGroup: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  result: TaskResult | null;
  error: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const AUTO_DISMISS_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HISTORY = 20;

let nextId = 1;

class TaskQueueStore {
  queue = $state<QueuedTask[]>([]);

  // Run functions stored outside $state to avoid proxying closures
  private runFns = new Map<string, TaskDefinition["run"]>();
  private actionCallbacks = new Map<string, (task: QueuedTask) => void>();
  private abortControllers = new Map<string, AbortController>();
  private processingGroups = new Set<string>();
  private autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly running = $derived(this.queue.filter((t) => t.status === "running"));
  readonly pending = $derived(this.queue.filter((t) => t.status === "pending"));
  readonly history = $derived(
    this.queue.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"),
  );
  readonly activeCount = $derived(
    this.queue.filter((t) => t.status === "running" || t.status === "pending").length,
  );
  readonly actionCount = $derived(
    this.queue.filter((t) => t.status === "completed" && t.result?.actionRequired).length,
  );
  readonly hasErrors = $derived(this.queue.some((t) => t.status === "failed"));
  readonly isIdle = $derived(
    this.queue.every((t) => t.status !== "running" && t.status !== "pending"),
  );

  isActive(keyOrPrefix: string): boolean {
    return this.queue.some(
      (t) =>
        (t.key === keyOrPrefix || t.key.startsWith(keyOrPrefix + ":")) &&
        (t.status === "pending" || t.status === "running"),
    );
  }

  /** Check if a specific task (exact key) is currently running. */
  isRunning(key: string): boolean {
    return this.queue.some((t) => t.key === key && t.status === "running");
  }

  /** Check if a specific task (exact key) is queued but not yet running. */
  isQueued(key: string): boolean {
    return this.queue.some((t) => t.key === key && t.status === "pending");
  }

  enqueue(def: TaskDefinition): string | null {
    // Reject duplicate keys
    if (this.queue.some((t) => t.key === def.key && (t.status === "pending" || t.status === "running"))) {
      return null;
    }

    const id = String(nextId++);
    const task: QueuedTask = {
      id,
      key: def.key,
      label: def.label,
      description: def.description,
      concurrencyGroup: def.concurrencyGroup ?? "default",
      status: "pending",
      progress: null,
      result: null,
      error: null,
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };

    this.runFns.set(id, def.run);
    if (def.onAction) this.actionCallbacks.set(id, def.onAction);
    this.queue.push(task);
    this.scheduleNext();
    return id;
  }

  cancel(id: string): void {
    const task = this.queue.find((t) => t.id === id);
    if (!task) return;

    if (task.status === "pending") {
      // Remove pending task immediately
      this.queue = this.queue.filter((t) => t.id !== id);
      this.runFns.delete(id);
      this.actionCallbacks.delete(id);
    } else if (task.status === "running") {
      // Abort the running task
      const controller = this.abortControllers.get(id);
      if (controller) {
        controller.abort();
      }
    }
  }

  dismiss(id: string): void {
    const task = this.queue.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      this.clearAutoDismissTimer(id);
      this.queue = this.queue.filter((t) => t.id !== id);
      this.runFns.delete(id);
      this.actionCallbacks.delete(id);
    }
  }

  handleAction(id: string): void {
    const task = this.queue.find((t) => t.id === id);
    if (!task) return;
    const cb = this.actionCallbacks.get(id);
    if (cb) cb(task);
  }

  clearHistory(): void {
    const toRemove = this.queue.filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    );
    for (const t of toRemove) {
      this.clearAutoDismissTimer(t.id);
      this.runFns.delete(t.id);
      this.actionCallbacks.delete(t.id);
    }
    this.queue = this.queue.filter(
      (t) => t.status === "pending" || t.status === "running",
    );
  }

  private scheduleNext(): void {
    // Find one pending task per idle concurrency group
    const startable = new Map<string, QueuedTask>();
    for (const task of this.queue) {
      if (task.status !== "pending") continue;
      if (this.processingGroups.has(task.concurrencyGroup)) continue;
      if (!startable.has(task.concurrencyGroup)) {
        startable.set(task.concurrencyGroup, task);
      }
    }
    for (const [group, task] of startable) {
      this.processingGroups.add(group); // mark busy synchronously before any await
      this.runTask(task); // fire-and-forget
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);

    task.status = "running";
    task.startedAt = Date.now();

    const runFn = this.runFns.get(task.id);
    if (!runFn) {
      task.status = "failed";
      task.error = "No run function found";
      task.finishedAt = Date.now();
      this.processingGroups.delete(task.concurrencyGroup);
      this.cleanup(task.id);
      this.scheduleNext();
      return;
    }

    try {
      const ctx: TaskContext = {
        signal: controller.signal,
        reportProgress: (progress: TaskProgress) => {
          task.progress = { ...progress };
        },
      };
      const result = await runFn(ctx);
      if (controller.signal.aborted) {
        task.status = "cancelled";
      } else {
        task.status = "completed";
        task.result = result ?? null;
        if (!result?.actionRequired) {
          this.scheduleAutoDismiss(task.id);
        }
      }
    } catch (err: unknown) {
      if (isAbortError(err) || controller.signal.aborted) {
        task.status = "cancelled";
      } else {
        task.status = "failed";
        task.error =
          err instanceof Error
            ? err.message || err.name || "Unknown error"
            : String(err) || "Unknown error";
      }
    } finally {
      task.finishedAt = Date.now();
      this.processingGroups.delete(task.concurrencyGroup);
      this.cleanup(task.id);
      this.trimHistory();
      this.scheduleNext();
    }
  }

  private cleanup(id: string): void {
    this.abortControllers.delete(id);
  }

  private scheduleAutoDismiss(id: string): void {
    this.clearAutoDismissTimer(id);
    const timer = setTimeout(() => {
      this.dismiss(id);
    }, AUTO_DISMISS_MS);
    this.autoDismissTimers.set(id, timer);
  }

  private clearAutoDismissTimer(id: string): void {
    const timer = this.autoDismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.autoDismissTimers.delete(id);
    }
  }

  private trimHistory(): void {
    const finished = this.queue.filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    );
    if (finished.length > MAX_HISTORY) {
      const toRemove = finished.slice(0, finished.length - MAX_HISTORY);
      const removeIds = new Set(toRemove.map((t) => t.id));
      for (const id of removeIds) {
        this.clearAutoDismissTimer(id);
        this.runFns.delete(id);
        this.actionCallbacks.delete(id);
      }
      this.queue = this.queue.filter((t) => !removeIds.has(t.id));
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

export const taskQueue = new TaskQueueStore();
