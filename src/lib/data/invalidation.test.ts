import { describe, it, expect, vi, beforeEach } from "vitest";
import { invalidate, onInvalidate } from "./invalidation.js";

// Each test gets a clean listener map. The module uses a module-level Map,
// so we rely on unsubscribing after each test to avoid cross-contamination.

describe("invalidation bus", () => {
  it("calls listener when its kind is invalidated", () => {
    const fn = vi.fn();
    const unsub = onInvalidate("journal", fn);
    invalidate("journal");
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not call listener for a different kind", () => {
    const fn = vi.fn();
    const unsub = onInvalidate("journal", fn);
    invalidate("accounts");
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("supports multiple kinds in one call", () => {
    const journalFn = vi.fn();
    const reportsFn = vi.fn();
    const unsub1 = onInvalidate("journal", journalFn);
    const unsub2 = onInvalidate("reports", reportsFn);
    invalidate("journal", "reports");
    expect(journalFn).toHaveBeenCalledTimes(1);
    expect(reportsFn).toHaveBeenCalledTimes(1);
    unsub1();
    unsub2();
  });

  it("unsubscribes correctly", () => {
    const fn = vi.fn();
    const unsub = onInvalidate("journal", fn);
    unsub();
    invalidate("journal");
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports multiple listeners on the same kind", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const unsub1 = onInvalidate("accounts", fn1);
    const unsub2 = onInvalidate("accounts", fn2);
    invalidate("accounts");
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    unsub1();
    unsub2();
  });

  it("handles invalidation with no listeners gracefully", () => {
    // Should not throw
    expect(() => invalidate("currencies")).not.toThrow();
  });
});
