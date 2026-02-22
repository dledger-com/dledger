import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to reset the module between tests to get a fresh singleton
let taskQueue: typeof import("./task-queue.svelte.js")["taskQueue"];

beforeEach(async () => {
  vi.useFakeTimers();
  // Dynamic import to get the module (singleton state persists, but we can work with it)
  const mod = await import("./task-queue.svelte.js");
  taskQueue = mod.taskQueue;
  // Clear any leftover tasks
  taskQueue.clearHistory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskQueueStore", () => {
  it("enqueue + auto-start: task runs immediately", async () => {
    const fn = vi.fn(async () => ({ summary: "done" }));
    const id = taskQueue.enqueue({ key: "test-1", label: "Test 1", run: fn });
    expect(id).not.toBeNull();

    // Let the microtask queue flush (task starts asynchronously)
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Wait for completion
    await vi.advanceTimersByTimeAsync(0);
    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.status).toBe("completed");
    expect(task?.result?.summary).toBe("done");

    // Cleanup
    taskQueue.dismiss(id!);
  });

  it("sequential: second task waits for first to finish", async () => {
    const order: string[] = [];

    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const id1 = taskQueue.enqueue({
      key: "seq-1",
      label: "First",
      async run() {
        order.push("first-start");
        await firstPromise;
        order.push("first-end");
      },
    });

    const id2 = taskQueue.enqueue({
      key: "seq-2",
      label: "Second",
      async run() {
        order.push("second-start");
        order.push("second-end");
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    // First should be running, second pending
    expect(taskQueue.queue.find((t) => t.id === id1)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === id2)?.status).toBe("pending");
    expect(order).toEqual(["first-start"]);

    // Resolve first
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toContain("first-end");
    expect(order).toContain("second-start");
    expect(order).toContain("second-end");

    // Both completed
    expect(taskQueue.queue.find((t) => t.id === id1)?.status).toBe("completed");
    expect(taskQueue.queue.find((t) => t.id === id2)?.status).toBe("completed");

    taskQueue.dismiss(id1!);
    taskQueue.dismiss(id2!);
  });

  it("deduplication: same key rejected while pending/running", async () => {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });

    const id1 = taskQueue.enqueue({
      key: "dup-key",
      label: "Task A",
      async run() {
        await p;
      },
    });
    expect(id1).not.toBeNull();

    const id2 = taskQueue.enqueue({
      key: "dup-key",
      label: "Task B",
      async run() {},
    });
    expect(id2).toBeNull();

    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    taskQueue.dismiss(id1!);
  });

  it("cancel pending task: immediate removal", async () => {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });

    // Block first task so second stays pending
    const id1 = taskQueue.enqueue({
      key: "blocker",
      label: "Blocker",
      async run() {
        await p;
      },
    });
    const id2 = taskQueue.enqueue({
      key: "to-cancel",
      label: "Cancelled",
      async run() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === id2)?.status).toBe("pending");

    taskQueue.cancel(id2!);
    expect(taskQueue.queue.find((t) => t.id === id2)).toBeUndefined();

    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    taskQueue.dismiss(id1!);
  });

  it("cancel running task: abort signal fires, status → cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });

    const id = taskQueue.enqueue({
      key: "abort-me",
      label: "Abort Me",
      async run(ctx) {
        receivedSignal = ctx.signal;
        await p;
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === id)?.status).toBe("running");

    taskQueue.cancel(id!);
    expect(receivedSignal?.aborted).toBe(true);

    // The promise is still pending; resolve it to let the task finish
    resolve!();
    await vi.advanceTimersByTimeAsync(0);

    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.status).toBe("cancelled");

    taskQueue.dismiss(id!);
  });

  it("progress reporting updates store", async () => {
    let reportProgress: ((p: { current: number; total: number; message?: string }) => void) | undefined;
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });

    const id = taskQueue.enqueue({
      key: "progress-task",
      label: "Progress",
      async run(ctx) {
        reportProgress = ctx.reportProgress;
        await p;
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(reportProgress).toBeDefined();

    reportProgress!({ current: 5, total: 10, message: "halfway" });
    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.progress?.current).toBe(5);
    expect(task?.progress?.total).toBe(10);
    expect(task?.progress?.message).toBe("halfway");

    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    taskQueue.dismiss(id!);
  });

  it("AbortError from fetch maps to cancelled not failed", async () => {
    const id = taskQueue.enqueue({
      key: "abort-error",
      label: "Abort Error",
      async run() {
        throw new DOMException("Aborted", "AbortError");
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.status).toBe("cancelled");

    taskQueue.dismiss(id!);
  });

  it("failed task persists, clearHistory removes it", async () => {
    const id = taskQueue.enqueue({
      key: "fail-task",
      label: "Fail",
      async run() {
        throw new Error("boom");
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.status).toBe("failed");
    expect(task?.error).toBe("boom");

    // Still in queue after 10 minutes (no auto-dismiss for failures)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(taskQueue.queue.find((t) => t.id === id)).toBeDefined();

    taskQueue.clearHistory();
    expect(taskQueue.queue.find((t) => t.id === id)).toBeUndefined();
  });

  it("auto-dismiss: successful tasks removed after 5 minutes", async () => {
    const id = taskQueue.enqueue({
      key: "auto-dismiss",
      label: "Auto",
      async run() {
        return { summary: "ok" };
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === id)?.status).toBe("completed");

    // Still there before 5 minutes
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(taskQueue.queue.find((t) => t.id === id)).toBeDefined();

    // Gone after 5 minutes
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(taskQueue.queue.find((t) => t.id === id)).toBeUndefined();
  });

  it("clearHistory only removes finished tasks", async () => {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });

    const id1 = taskQueue.enqueue({
      key: "running-task",
      label: "Running",
      async run() {
        await p;
      },
    });

    // Add a completed task
    const id2 = taskQueue.enqueue({
      key: "done-task",
      label: "Done",
      async run() {},
    });

    await vi.advanceTimersByTimeAsync(0);

    // id1 is running, id2 is pending (waiting for id1)
    // Actually id1 is running, id2 is still pending
    expect(taskQueue.queue.find((t) => t.id === id1)?.status).toBe("running");

    taskQueue.clearHistory();

    // Running task should still be there
    expect(taskQueue.queue.find((t) => t.id === id1)).toBeDefined();
    // Pending task should still be there
    expect(taskQueue.queue.find((t) => t.id === id2)).toBeDefined();

    resolve!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    taskQueue.dismiss(id1!);
    taskQueue.dismiss(id2!);
  });
});
