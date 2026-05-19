import { describe, it, expect } from "vitest";
import Decimal from "decimal.js-light";
import {
  irScale,
  marginalRate,
  recommendRegime,
  bracketsForYear,
  BAREME_BRACKETS,
  LATEST_BAREME_YEAR,
} from "./french-bareme.js";

describe("irScale", () => {
  it("returns 0 for non-positive revenue", () => {
    expect(irScale(0, 1, 2024).toString()).toBe("0");
    expect(irScale(-1000, 1, 2024).toString()).toBe("0");
  });

  it("returns 0 in the first tranche (under 11 497 € for 2024)", () => {
    expect(irScale(10000, 1, 2024).toString()).toBe("0");
    expect(irScale(11497, 1, 2024).toString()).toBe("0");
  });

  it("matches the 11% bracket for a single part, 2024 income year", () => {
    // 20 000 € income, 1 part → 0 % on 0–11 497, 11 % on 11 497–20 000.
    // Tax = (20000 - 11497) * 0.11 = 8503 * 0.11 = 935.33
    expect(irScale(20000, 1, 2024).toFixed(2)).toBe("935.33");
  });

  it("crosses into the 30% bracket correctly", () => {
    // 50 000 € income, 1 part:
    // 0 on first 11 497, 0.11 × (29315 - 11497) = 1959.98 on the 11% slice,
    // 0.30 × (50000 - 29315) = 6205.50 on the 30% slice. Total ≈ 8165.48.
    expect(irScale(50000, 1, 2024).toFixed(2)).toBe("8165.48");
  });

  it("applies the quotient familial: 2 parts halves the per-part income", () => {
    // 50 000 € income, 2 parts → per-part 25 000 → 0.11 × (25000 - 11497) = 1485.33.
    // Multiplied by 2 parts = 2970.66.
    expect(irScale(50000, 2, 2024).toFixed(2)).toBe("2970.66");
  });

  it("walks all the way to the 45% top bracket", () => {
    // 200 000 €, 1 part:
    // (29315-11497)*0.11 = 1959.98
    // (83823-29315)*0.30 = 16352.40
    // (180294-83823)*0.41 = 39553.11
    // (200000-180294)*0.45 = 8867.70
    // Total = 66733.19
    expect(irScale(200000, 1, 2024).toFixed(2)).toBe("66733.19");
  });

  it("uses the pre-2020 14% second-bracket rate for 2019", () => {
    // 20 000 €, 1 part, 2019 brackets: (20000 - 10064) × 0.14 = 9936 × 0.14 = 1391.04
    expect(irScale(20000, 1, 2019).toFixed(2)).toBe("1391.04");
  });

  it("uses the 2025 (loi de finances 2026) thresholds", () => {
    // 2025 first cut-off is 11 600. At 11 600 income, tax is 0.
    expect(irScale(11600, 1, 2025).toFixed(2)).toBe("0.00");
    // At 20 000 → (20000 - 11600) * 0.11 = 924.00
    expect(irScale(20000, 1, 2025).toFixed(2)).toBe("924.00");
  });
});

describe("bracketsForYear", () => {
  it("returns the exact bracket table when one exists for the year", () => {
    const { brackets, fallback } = bracketsForYear(2024);
    expect(brackets).toBe(BAREME_BRACKETS[2024]);
    expect(fallback).toBeNull();
  });

  it("falls back to the latest known year for future income years", () => {
    const { brackets, fallback } = bracketsForYear(2099);
    expect(brackets).toBe(BAREME_BRACKETS[LATEST_BAREME_YEAR]);
    expect(fallback).toBe(LATEST_BAREME_YEAR);
  });
});

describe("marginalRate", () => {
  it("0 in the first tranche", () => {
    expect(marginalRate(5000, 1, 2024)).toBe(0);
  });

  it("11% in the second tranche", () => {
    expect(marginalRate(20000, 1, 2024)).toBe(0.11);
  });

  it("30% in the third tranche", () => {
    expect(marginalRate(50000, 1, 2024)).toBe(0.30);
  });

  it("45% above the top threshold", () => {
    expect(marginalRate(250000, 1, 2024)).toBe(0.45);
  });

  it("applies quotient familial: 2 parts at 50 000 → per-part 25 000 → 11% bracket", () => {
    expect(marginalRate(50000, 2, 2024)).toBe(0.11);
  });
});

describe("recommendRegime", () => {
  it("picks barème when the user has no other income (TMI 0% on small gains)", () => {
    const r = recommendRegime({ cryptoGain: 5000, otherIncome: 0, parts: 1, year: 2024 });
    expect(r.recommendation).toBe("bareme");
    expect(r.baremeIR).toBe("0.00");
    expect(r.pfuIR).toBe("640.00"); // 5000 * 0.128
    expect(r.savings).toBe("640.00");
    expect(r.marginalRate).toBe(0);
  });

  it("picks PFU when the user is in the 30% TMI", () => {
    const r = recommendRegime({ cryptoGain: 10000, otherIncome: 50000, parts: 1, year: 2024 });
    expect(r.recommendation).toBe("pfu");
    expect(r.pfuIR).toBe("1280.00"); // 10000 * 0.128
    // Marginal IR: revenue jumps 50000 → 60000, both fully in 30% bracket → +3000 IR
    expect(r.baremeIR).toBe("3000.00");
    expect(r.savings).toBe("1720.00");
    expect(r.marginalRate).toBe(0.30);
  });

  it("picks barème when the user is in the 11% TMI and the gain stays in it", () => {
    // Other income 20 000 + gain 5000 = 25 000, all under 29 315 → fully 11% bracket.
    const r = recommendRegime({ cryptoGain: 5000, otherIncome: 20000, parts: 1, year: 2024 });
    expect(r.recommendation).toBe("bareme");
    expect(r.baremeIR).toBe("550.00"); // 5000 * 0.11
    expect(r.pfuIR).toBe("640.00");
    expect(r.savings).toBe("90.00");
    expect(r.marginalRate).toBe(0.11);
  });

  it("picks PFU when the gain pushes the user from the 11% into the 30% bracket", () => {
    // Other income 25 000, gain 10 000 → final 35 000.
    // 11% on (29 315 − 25 000) = 4 315 × 0.11 = 474.65
    // 30% on (35 000 − 29 315) = 5 685 × 0.30 = 1 705.50
    // Total marginal IR on gain = 474.65 + 1705.50 = 2180.15
    // PFU = 10000 * 0.128 = 1280 → PFU wins.
    const r = recommendRegime({ cryptoGain: 10000, otherIncome: 25000, parts: 1, year: 2024 });
    expect(r.recommendation).toBe("pfu");
    expect(r.pfuIR).toBe("1280.00");
    expect(r.baremeIR).toBe("2180.15");
  });

  it("respects quotient familial — same income with 2 parts can land in 0% TMI", () => {
    // 30 000 € total income, 2 parts → per-part 15 000 € → mostly 11% bracket.
    // Without crypto: (15000 - 11497) * 0.11 * 2 parts = 770.66
    // With crypto +5000 → 35000 total → per-part 17500 → (17500 - 11497) * 0.11 * 2 = 1320.66
    // Bareme marginal IR = 1320.66 - 770.66 = 550 → barème wins vs PFU 640.
    const r = recommendRegime({ cryptoGain: 5000, otherIncome: 30000, parts: 2, year: 2024 });
    expect(r.recommendation).toBe("bareme");
    expect(r.baremeIR).toBe("550.00");
  });

  it("uses the 2025 brackets correctly via fallback for income year 2025", () => {
    // 2025 cut-off is 11 600. 5000 € gain with no other income → 0 IR under barème.
    const r = recommendRegime({ cryptoGain: 5000, otherIncome: 0, parts: 1, year: 2025 });
    expect(r.bracketFallbackYear).toBeNull();
    expect(r.baremeIR).toBe("0.00");
    expect(r.recommendation).toBe("bareme");
  });

  it("flags bracket fallback for income years past the latest legislated table", () => {
    const r = recommendRegime({ cryptoGain: 5000, otherIncome: 0, parts: 1, year: 2099 });
    expect(r.bracketFallbackYear).toBe(LATEST_BAREME_YEAR);
  });

  it("declares a tie when barème IR equals PFU IR exactly", () => {
    // Engineer a tie: gain entirely in the 11% bracket, PFU 12.8% — never exactly equal,
    // so tie is mainly defensive. Use baremeIR === pfuIR by construction.
    // A direct test: 0 gain → both 0 → tie.
    const r = recommendRegime({ cryptoGain: 0, otherIncome: 50000, parts: 1, year: 2024 });
    expect(r.recommendation).toBe("tie");
    expect(r.pfuIR).toBe("0.00");
    expect(r.baremeIR).toBe("0.00");
  });

  it("ignores PS rate — gives the same answer regardless of social-contributions reform", () => {
    // The recommendation function never reads a PS rate; both regimes pay the same PS.
    // This is a meta-test that the API surface doesn't expose a PS knob.
    const r1 = recommendRegime({ cryptoGain: 10000, otherIncome: 50000, parts: 1, year: 2024 });
    const r2 = recommendRegime({ cryptoGain: 10000, otherIncome: 50000, parts: 1, year: 2025 });
    // The IR portions differ only because of the bracket table indexation.
    expect(r1.pfuIR).toBe(r2.pfuIR); // same gain × same flat IR rate
  });

  it("handles fractional Decimal inputs", () => {
    const r = recommendRegime({
      cryptoGain: new Decimal("5000.50"),
      otherIncome: new Decimal("19999.50"),
      parts: 1,
      year: 2024,
    });
    expect(r.pfuIR).toBe("640.06"); // 5000.50 * 0.128
  });
});
