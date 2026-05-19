/**
 * French progressive income tax scale (barème de l'impôt sur le revenu) and
 * PFU-vs-barème comparison for crypto capital gains (Form 2042-C, box 3AN).
 *
 * The decision: PFU is a flat 12.8% IR. Barème applies the progressive scale
 * to your total taxable income. The 17.2% (18.6% from 2025) social contributions
 * apply identically in both regimes — they cancel out and don't enter the
 * decision. So the question reduces to: does the gain push you into a marginal
 * rate above or below 12.8%?
 *
 * Sources: service-public.gouv.fr/particuliers/vosdroits/F1419, loi de finances
 * pour 2025 (revenus 2024), loi de finances pour 2026 (revenus 2025).
 */
import Decimal from "decimal.js-light";

/** PFU flat income-tax rate on PFU-eligible income (always 12.8%, social
 *  contributions are separate and identical in both regimes). */
export const PFU_IR_RATE = new Decimal("0.128");

export interface Bracket {
  /** Lower bound of the slice (per fiscal part), inclusive. */
  from: number;
  /** Upper bound, exclusive; null means "and above". */
  to: number | null;
  /** Marginal rate applied to income falling in this slice. */
  rate: number;
}

/**
 * Brackets indexed by **income year** (the year the revenue was earned, declared
 * the following spring). Rates: 0 / 11 (or 14 pre-2020) / 30 / 41 / 45 %.
 *
 * Update annually after each loi de finances is promulgated.
 */
export const BAREME_BRACKETS: Record<number, Bracket[]> = {
  2019: [
    { from: 0, to: 10064, rate: 0 },
    { from: 10064, to: 27794, rate: 0.14 },
    { from: 27794, to: 74517, rate: 0.30 },
    { from: 74517, to: 157806, rate: 0.41 },
    { from: 157806, to: null, rate: 0.45 },
  ],
  2020: [
    { from: 0, to: 10084, rate: 0 },
    { from: 10084, to: 25710, rate: 0.11 },
    { from: 25710, to: 73516, rate: 0.30 },
    { from: 73516, to: 158122, rate: 0.41 },
    { from: 158122, to: null, rate: 0.45 },
  ],
  2021: [
    { from: 0, to: 10225, rate: 0 },
    { from: 10225, to: 26070, rate: 0.11 },
    { from: 26070, to: 74545, rate: 0.30 },
    { from: 74545, to: 160336, rate: 0.41 },
    { from: 160336, to: null, rate: 0.45 },
  ],
  2022: [
    { from: 0, to: 10777, rate: 0 },
    { from: 10777, to: 27478, rate: 0.11 },
    { from: 27478, to: 78570, rate: 0.30 },
    { from: 78570, to: 168994, rate: 0.41 },
    { from: 168994, to: null, rate: 0.45 },
  ],
  2023: [
    { from: 0, to: 11294, rate: 0 },
    { from: 11294, to: 28797, rate: 0.11 },
    { from: 28797, to: 82341, rate: 0.30 },
    { from: 82341, to: 177106, rate: 0.41 },
    { from: 177106, to: null, rate: 0.45 },
  ],
  // Loi de finances pour 2025 (déclaration printemps 2025).
  2024: [
    { from: 0, to: 11497, rate: 0 },
    { from: 11497, to: 29315, rate: 0.11 },
    { from: 29315, to: 83823, rate: 0.30 },
    { from: 83823, to: 180294, rate: 0.41 },
    { from: 180294, to: null, rate: 0.45 },
  ],
  // Loi de finances pour 2026 — promulguée 2026-02-19, revalorisation +0,9%.
  2025: [
    { from: 0, to: 11600, rate: 0 },
    { from: 11600, to: 29579, rate: 0.11 },
    { from: 29579, to: 84577, rate: 0.30 },
    { from: 84577, to: 181917, rate: 0.41 },
    { from: 181917, to: null, rate: 0.45 },
  ],
};

/** Year of the most recently published table. Used to fall back when the user
 *  picks a year for which the bracket table hasn't been encoded yet. */
export const LATEST_BAREME_YEAR = Math.max(...Object.keys(BAREME_BRACKETS).map(Number));

/**
 * Pick the bracket table for `year`, falling back to the latest known year
 * when `year` is past the legislated range.
 */
export function bracketsForYear(year: number): { brackets: Bracket[]; fallback: number | null } {
  if (BAREME_BRACKETS[year]) return { brackets: BAREME_BRACKETS[year], fallback: null };
  return { brackets: BAREME_BRACKETS[LATEST_BAREME_YEAR], fallback: LATEST_BAREME_YEAR };
}

/**
 * Compute IR via the progressive scale with quotient familial.
 *
 * Algorithm: divide total taxable revenue by the number of fiscal parts,
 * apply the bracket schedule to the per-part figure, then multiply the
 * resulting tax by the number of parts.
 *
 * Plafonnement du quotient familial is NOT applied — disclaimed in the UI.
 */
export function irScale(revenue: Decimal | number | string, parts: number, year: number): Decimal {
  const r = revenue instanceof Decimal ? revenue : new Decimal(revenue);
  if (r.lte(0) || parts <= 0) return new Decimal(0);
  const { brackets } = bracketsForYear(year);
  const perPart = r.div(parts);
  let tax = new Decimal(0);
  for (const b of brackets) {
    if (perPart.lte(b.from)) break;
    const upper = b.to === null ? perPart : new Decimal(b.to);
    const sliceTop = perPart.lt(upper) ? perPart : upper;
    const slice = sliceTop.minus(b.from);
    if (slice.lte(0)) break;
    tax = tax.plus(slice.times(b.rate));
    if (b.to === null || perPart.lte(b.to)) break;
  }
  return tax.times(parts);
}

/**
 * Find the marginal rate (TMI) that applies to the *last* euro of `revenue`
 * for a household with `parts` parts in `year`. Returned as a decimal (e.g. 0.30).
 */
export function marginalRate(revenue: Decimal | number | string, parts: number, year: number): number {
  const r = revenue instanceof Decimal ? revenue : new Decimal(revenue);
  if (r.lte(0) || parts <= 0) return 0;
  const { brackets } = bracketsForYear(year);
  const perPart = r.div(parts);
  let rate = 0;
  for (const b of brackets) {
    if (perPart.gt(b.from)) rate = b.rate;
    else break;
  }
  return rate;
}

export type RegimeChoice = "pfu" | "bareme" | "tie";

export interface RegimeRecommendation {
  /** IR portion under PFU = 12.8% × gain. */
  pfuIR: string;
  /** Marginal IR cost of adding the gain under barème, given other income. */
  baremeIR: string;
  /** Marginal rate that applies to the gain under barème (0, 0.11, 0.30, ...). */
  marginalRate: number;
  /** Which regime costs less IR on the gain. */
  recommendation: RegimeChoice;
  /** Absolute IR savings vs the alternative. Always ≥ 0. */
  savings: string;
  /** Bracket-table fallback year (null if the requested year has a table). */
  bracketFallbackYear: number | null;
}

export interface RecommendRegimeArgs {
  /** Crypto capital gain for the year (box 3AN equivalent, EUR). Must be > 0. */
  cryptoGain: Decimal | number | string;
  /** User's other taxable income for the year (salaire net imposable + autres). */
  otherIncome: Decimal | number | string;
  /** Number of fiscal parts (quotient familial). Default 1. */
  parts: number;
  /** Income year (year revenue was earned). */
  year: number;
}

export function recommendRegime(args: RecommendRegimeArgs): RegimeRecommendation {
  const gain = args.cryptoGain instanceof Decimal ? args.cryptoGain : new Decimal(args.cryptoGain);
  const other = args.otherIncome instanceof Decimal ? args.otherIncome : new Decimal(args.otherIncome);
  const parts = args.parts > 0 ? args.parts : 1;
  const { fallback } = bracketsForYear(args.year);

  const pfuIR = gain.times(PFU_IR_RATE);

  const irWithoutGain = irScale(other, parts, args.year);
  const irWithGain = irScale(other.plus(gain), parts, args.year);
  const baremeIR = irWithGain.minus(irWithoutGain);

  const rate = marginalRate(other.plus(gain), parts, args.year);

  let choice: RegimeChoice;
  if (baremeIR.eq(pfuIR)) choice = "tie";
  else if (baremeIR.lt(pfuIR)) choice = "bareme";
  else choice = "pfu";

  const diff = baremeIR.minus(pfuIR).abs();

  return {
    pfuIR: pfuIR.toFixed(2),
    baremeIR: baremeIR.toFixed(2),
    marginalRate: rate,
    recommendation: choice,
    savings: diff.toFixed(2),
    bracketFallbackYear: fallback,
  };
}
