/**
 * Group sorted YYYY-MM-DD date strings into contiguous intervals.
 * Consecutive dates (day+1) are merged; isolated dates become single-day intervals.
 */
export function groupDateIntervals(dates: string[]): { from: string; to: string }[] {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const intervals: { from: string; to: string }[] = [];

  let from = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (isNextDay(prev, curr)) {
      prev = curr;
    } else {
      intervals.push({ from, to: prev });
      from = curr;
      prev = curr;
    }
  }
  intervals.push({ from, to: prev });

  return intervals;
}

/** Check if `b` is exactly one day after `a` (both YYYY-MM-DD). */
function isNextDay(a: string, b: string): boolean {
  // Parse as UTC to avoid timezone issues
  const [ay, am, ad] = a.split("-").map(Number);
  const da = new Date(Date.UTC(ay, am - 1, ad + 1));
  const expected = `${da.getUTCFullYear()}-${String(da.getUTCMonth() + 1).padStart(2, "0")}-${String(da.getUTCDate()).padStart(2, "0")}`;
  return expected === b;
}

/** Format an interval for display. Single-day: "2025-01-07", range: "2025-01-04 – 2025-03-17". */
export function formatInterval(iv: { from: string; to: string }): string {
  return iv.from === iv.to ? iv.from : `${iv.from} – ${iv.to}`;
}
