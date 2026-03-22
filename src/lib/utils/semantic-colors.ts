/**
 * Semantic color tokens as Tailwind class strings.
 *
 * These map to CSS custom properties defined in app.css (--positive, --negative,
 * --link, --warning-accent) that auto-switch between light and dark mode.
 *
 * For simple text coloring, prefer the CSS token classes (e.g. `text-positive`)
 * directly in templates. Use these constants and helpers for computed/conditional
 * color logic in scripts.
 */

// ── Text color tokens (use CSS tokens directly in templates when possible) ──

/** Green in light, lighter green in dark — for gains, revenue, passing checks */
export const COLOR_POSITIVE = "text-positive";

/** Red in light, lighter red in dark — for losses, expenses, failed checks */
export const COLOR_NEGATIVE = "text-negative";

/** Blue in light, lighter blue in dark — for navigational links */
export const COLOR_LINK = "text-link";

// ── Amount color helper ──

/** Returns `text-positive` or `text-negative` based on sign */
export function amountColor(value: number): string {
	if (value > 0) return COLOR_POSITIVE;
	if (value < 0) return COLOR_NEGATIVE;
	return "";
}

// ── Banner patterns (border + bg + text combos) ──

export const BANNER_WARNING =
	"rounded-md border border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200";

export const BANNER_INFO =
	"rounded-md border border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200";

export const BANNER_SUCCESS =
	"rounded-md border border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200";

export const BANNER_ERROR =
	"rounded-md border border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200";
