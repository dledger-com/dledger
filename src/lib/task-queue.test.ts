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

  it("default concurrencyGroup is 'default'", async () => {
    const id = taskQueue.enqueue({
      key: "group-default",
      label: "Default Group",
      async run() { return { summary: "ok" }; },
    });
    const task = taskQueue.queue.find((t) => t.id === id);
    expect(task?.concurrencyGroup).toBe("default");

    await vi.advanceTimersByTimeAsync(0);
    taskQueue.dismiss(id!);
  });

  it("parallel execution: tasks in different groups run concurrently", async () => {
    const order: string[] = [];
    let resolveA: () => void;
    let resolveB: () => void;
    const promiseA = new Promise<void>((r) => { resolveA = r; });
    const promiseB = new Promise<void>((r) => { resolveB = r; });

    const idA = taskQueue.enqueue({
      key: "par-a",
      label: "A",
      concurrencyGroup: "group-a",
      async run() {
        order.push("a-start");
        await promiseA;
        order.push("a-end");
      },
    });
    const idB = taskQueue.enqueue({
      key: "par-b",
      label: "B",
      concurrencyGroup: "group-b",
      async run() {
        order.push("b-start");
        await promiseB;
        order.push("b-end");
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    // Both should be running simultaneously
    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");
    expect(order).toEqual(["a-start", "b-start"]);

    resolveA!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toContain("a-end");

    resolveB!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toContain("b-end");

    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("completed");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("completed");

    taskQueue.dismiss(idA!);
    taskQueue.dismiss(idB!);
  });

  it("same-group sequential: tasks in the same group wait", async () => {
    const order: string[] = [];
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

    const id1 = taskQueue.enqueue({
      key: "same-1",
      label: "Same 1",
      concurrencyGroup: "shared",
      async run() {
        order.push("first-start");
        await firstPromise;
        order.push("first-end");
      },
    });
    const id2 = taskQueue.enqueue({
      key: "same-2",
      label: "Same 2",
      concurrencyGroup: "shared",
      async run() {
        order.push("second-start");
        order.push("second-end");
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(taskQueue.queue.find((t) => t.id === id1)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === id2)?.status).toBe("pending");
    expect(order).toEqual(["first-start"]);

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toContain("first-end");
    expect(order).toContain("second-start");
    expect(order).toContain("second-end");

    taskQueue.dismiss(id1!);
    taskQueue.dismiss(id2!);
  });

  it("mixed groups: parallel across groups, sequential within", async () => {
    const order: string[] = [];
    let resolveA1: () => void;
    let resolveB: () => void;
    const promiseA1 = new Promise<void>((r) => { resolveA1 = r; });
    const promiseB = new Promise<void>((r) => { resolveB = r; });

    const idA1 = taskQueue.enqueue({
      key: "mix-a1",
      label: "A1",
      concurrencyGroup: "alpha",
      async run() { order.push("a1-start"); await promiseA1; order.push("a1-end"); },
    });
    const idA2 = taskQueue.enqueue({
      key: "mix-a2",
      label: "A2",
      concurrencyGroup: "alpha",
      async run() { order.push("a2-start"); order.push("a2-end"); },
    });
    const idB = taskQueue.enqueue({
      key: "mix-b",
      label: "B",
      concurrencyGroup: "beta",
      async run() { order.push("b-start"); await promiseB; order.push("b-end"); },
    });

    await vi.advanceTimersByTimeAsync(0);

    // A1 and B should be running; A2 should be pending (same group as A1)
    expect(taskQueue.queue.find((t) => t.id === idA1)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === idA2)?.status).toBe("pending");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");
    expect(order).toEqual(["a1-start", "b-start"]);

    // Complete A1 → A2 should start
    resolveA1!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toContain("a1-end");
    expect(order).toContain("a2-start");
    expect(taskQueue.queue.find((t) => t.id === idA2)?.status).toBe("completed");

    // B still running
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");

    resolveB!();
    await vi.advanceTimersByTimeAsync(0);

    expect(taskQueue.queue.find((t) => t.id === idA1)?.status).toBe("completed");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("completed");

    taskQueue.dismiss(idA1!);
    taskQueue.dismiss(idA2!);
    taskQueue.dismiss(idB!);
  });

  it("cancel in one group does not affect another", async () => {
    let resolveA: () => void;
    let resolveB: () => void;
    const promiseA = new Promise<void>((r) => { resolveA = r; });
    const promiseB = new Promise<void>((r) => { resolveB = r; });

    const idA = taskQueue.enqueue({
      key: "cancel-a",
      label: "A",
      concurrencyGroup: "grp-a",
      async run() { await promiseA; },
    });
    const idB = taskQueue.enqueue({
      key: "cancel-b",
      label: "B",
      concurrencyGroup: "grp-b",
      async run() { await promiseB; },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");

    // Cancel A
    taskQueue.cancel(idA!);
    resolveA!();
    await vi.advanceTimersByTimeAsync(0);

    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("cancelled");
    // B still running
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");

    resolveB!();
    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("completed");

    taskQueue.dismiss(idA!);
    taskQueue.dismiss(idB!);
  });

  it("bulk enqueue: one task per unique group starts immediately", async () => {
    const resolvers: (() => void)[] = [];
    const ids: string[] = [];

    // Enqueue 12 tasks across 4 groups (3 per group)
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 3; i++) {
        let resolve: () => void;
        const p = new Promise<void>((r) => { resolve = r; });
        resolvers.push(resolve!);
        const id = taskQueue.enqueue({
          key: `bulk-g${g}-${i}`,
          label: `G${g}-${i}`,
          concurrencyGroup: `bulk-group-${g}`,
          async run() { await p; },
        });
        ids.push(id!);
      }
    }

    await vi.advanceTimersByTimeAsync(0);

    // Exactly 4 running (one per group), 8 pending
    const running = taskQueue.queue.filter((t) => t.status === "running");
    const pending = taskQueue.queue.filter((t) => t.status === "pending");
    expect(running.length).toBe(4);
    expect(pending.length).toBe(8);

    // Each running task is the first enqueued in its group
    const runningKeys = running.map((t) => t.key).sort();
    expect(runningKeys).toEqual(["bulk-g0-0", "bulk-g1-0", "bulk-g2-0", "bulk-g3-0"]);

    // Cleanup: resolve all and flush enough times for all 3 rounds per group
    for (const r of resolvers) r();
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    taskQueue.clearHistory();
  });

  it("isIdle requires all groups to be idle", async () => {
    // Ensure clean slate — wait for any cascading tasks from previous tests
    for (let i = 0; i < 15; i++) await vi.advanceTimersByTimeAsync(0);
    taskQueue.clearHistory();

    let resolveA: () => void;
    let resolveB: () => void;
    const promiseA = new Promise<void>((r) => { resolveA = r; });
    const promiseB = new Promise<void>((r) => { resolveB = r; });

    const idA = taskQueue.enqueue({
      key: "idle-a",
      label: "A",
      concurrencyGroup: "grp-x",
      async run() { await promiseA; },
    });
    const idB = taskQueue.enqueue({
      key: "idle-b",
      label: "B",
      concurrencyGroup: "grp-y",
      async run() { await promiseB; },
    });

    await vi.advanceTimersByTimeAsync(0);

    // Both running — not idle (check via status, not $derived)
    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("running");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");
    expect(taskQueue.queue.filter((t) => t.status === "running" || t.status === "pending").length).toBeGreaterThan(0);

    // Complete A — still not idle because B is running
    resolveA!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === idA)?.status).toBe("completed");
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("running");

    // Complete B — now idle
    resolveB!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(taskQueue.queue.find((t) => t.id === idB)?.status).toBe("completed");
    expect(taskQueue.queue.filter((t) => t.status === "running" || t.status === "pending").length).toBe(0);

    taskQueue.dismiss(idA!);
    taskQueue.dismiss(idB!);
  });
});
