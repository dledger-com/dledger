import { describe, it, expect } from "vitest";
import { groupDateIntervals, formatInterval } from "./date-intervals.js";

describe("groupDateIntervals", () => {
  it("returns empty for no dates", () => {
    expect(groupDateIntervals([])).toEqual([]);
  });

  it("returns single-day interval for one date", () => {
    expect(groupDateIntervals(["2025-01-07"])).toEqual([
      { from: "2025-01-07", to: "2025-01-07" },
    ]);
  });

  it("merges consecutive days into one interval", () => {
    expect(groupDateIntervals(["2025-01-01", "2025-01-02", "2025-01-03"])).toEqual([
      { from: "2025-01-01", to: "2025-01-03" },
    ]);
  });

  it("splits non-consecutive dates into separate intervals", () => {
    expect(groupDateIntervals(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-10"])).toEqual([
      { from: "2025-01-01", to: "2025-01-03" },
      { from: "2025-01-10", to: "2025-01-10" },
    ]);
  });

  it("handles month boundaries", () => {
    expect(groupDateIntervals(["2025-01-31", "2025-02-01"])).toEqual([
      { from: "2025-01-31", to: "2025-02-01" },
    ]);
  });

  it("handles unsorted input", () => {
    expect(groupDateIntervals(["2025-01-10", "2025-01-01", "2025-01-02"])).toEqual([
      { from: "2025-01-01", to: "2025-01-02" },
      { from: "2025-01-10", to: "2025-01-10" },
    ]);
  });

  it("handles many separate intervals", () => {
    const result = groupDateIntervals(["2025-01-01", "2025-01-05", "2025-01-10"]);
    expect(result).toHaveLength(3);
  });
});

describe("formatInterval", () => {
  it("formats single-day interval", () => {
    expect(formatInterval({ from: "2025-01-07", to: "2025-01-07" })).toBe("2025-01-07");
  });

  it("formats range interval", () => {
    expect(formatInterval({ from: "2025-01-01", to: "2025-03-17" })).toBe("2025-01-01 – 2025-03-17");
  });
});
