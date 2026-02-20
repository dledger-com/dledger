import { describe, it, expect, beforeEach } from "vitest";
import { seedBasicLedger, type SeededLedger } from "../../test/helpers.js";
import { computeNetWorthSeries, computeExpenseBreakdown, monthEndDates } from "./balance-history.js";

describe("monthEndDates", () => {
  it("generates monthly end dates for short range", () => {
    const dates = monthEndDates(new Date("2024-01-01"), new Date("2024-06-30"));
    // Should include end of Jan through Jun (6 months)
    expect(dates.length).toBeGreaterThanOrEqual(6);
    // First date should be end of January (exact string depends on TZ)
    expect(dates[0]).toMatch(/^2024-01-3[01]$/);
    // Last date should be exactly the "to" date formatted
    const toStr = new Date("2024-06-30").toISOString().slice(0, 10);
    expect(dates).toContain(toStr);
  });

  it("generates quarterly dates for medium range", () => {
    const from = new Date("2019-01-01");
    const to = new Date("2024-12-31");
    const dates = monthEndDates(from, to);
    // 72 months > 60, so should be quarterly
    // Should be fewer than monthly (72 monthly -> ~24 quarterly)
    expect(dates.length).toBeLessThan(72);
    expect(dates.length).toBeGreaterThan(10);
    // All dates should be valid YYYY-MM-DD strings
    for (const d of dates) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("generates yearly dates for long range", () => {
    const from = new Date("2010-01-01");
    const to = new Date("2024-12-31");
    const dates = monthEndDates(from, to);
    // 180 months > 120, so yearly
    expect(dates.length).toBeLessThan(30);
    expect(dates.length).toBeGreaterThan(5);
  });

  it("always includes the final date", () => {
    const dates = monthEndDates(new Date("2024-01-01"), new Date("2024-03-15"));
    expect(dates[dates.length - 1]).toBe("2024-03-15");
  });
});

describe("computeNetWorthSeries", () => {
  let seed: SeededLedger;

  beforeEach(async () => {
    seed = await seedBasicLedger();
  });

  it("returns net worth points", async () => {
    const points = await computeNetWorthSeries(
      seed.backend,
      "2024-01-01",
      "2024-03-31",
      "USD",
    );
    expect(points.length).toBeGreaterThan(0);
    // Each point should have a date, label, and numeric value
    for (const p of points) {
      expect(p.date).toBeInstanceOf(Date);
      expect(typeof p.label).toBe("string");
      expect(typeof p.value).toBe("number");
    }
  });

  it("reflects posted transactions in net worth", async () => {
    const points = await computeNetWorthSeries(
      seed.backend,
      "2024-01-01",
      "2024-01-31",
      "USD",
    );
    // The seeded ledger has: +1000 opening, +3000 salary, -50 food = 3950 net assets
    // But net worth = assets - liabilities; with just assets it should be > 0
    const lastPoint = points[points.length - 1];
    expect(lastPoint.value).toBeGreaterThan(0);
  });
});

describe("computeExpenseBreakdown", () => {
  let seed: SeededLedger;

  beforeEach(async () => {
    seed = await seedBasicLedger();
  });

  it("returns expense categories", async () => {
    const categories = await computeExpenseBreakdown(
      seed.backend,
      "2024-01-01",
      "2024-01-31",
      "USD",
    );
    // The seeded ledger has a $50 food expense
    expect(categories.length).toBeGreaterThan(0);
    const food = categories.find((c) => c.category === "Food");
    expect(food).toBeDefined();
    expect(food!.amount).toBe(50);
  });

  it("limits categories with maxCategories", async () => {
    const categories = await computeExpenseBreakdown(
      seed.backend,
      "2024-01-01",
      "2024-01-31",
      "USD",
      2,
    );
    expect(categories.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for no expenses", async () => {
    const categories = await computeExpenseBreakdown(
      seed.backend,
      "2020-01-01",
      "2020-01-31",
      "USD",
    );
    expect(categories).toHaveLength(0);
  });
});
