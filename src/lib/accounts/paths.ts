// Centralized account path constants and builders.
// Single point of change for all account path strings used across the codebase.
//
// Prefixes are configurable via configureAccountPaths(). Call sites don't change —
// they keep calling the same builder functions, which read from the config.

// ── Configurable Prefix Types ──────────────────────────

export interface AccountPathConfig {
	// Banking
	bankAssets: string;
	bankFees: string;
	creditCards: string;
	// Exchange
	exchangeAssets: string;
	exchangeFees: string;
	exchangeEquity: string;
	exchangeStaking: string;
	exchangeIncome: string;
	exchangeExpenses: string;
	// Wallet / On-chain
	walletAssets: string;
	walletEquity: string;
	chainFees: string;
	// DeFi
	defiAssets: string;
	defiLiabilities: string;
	defiIncome: string;
	defiExpenses: string;
}

export const DEFAULT_PATH_CONFIG: Readonly<AccountPathConfig> = {
	bankAssets: "Assets:Bank",
	bankFees: "Expenses:Bank:Fees",
	creditCards: "Liabilities:CreditCards",
	exchangeAssets: "Assets:Crypto:Exchange",
	exchangeFees: "Expenses:Crypto:Fees:Trading",
	exchangeEquity: "Equity:Crypto:Exchange",
	exchangeStaking: "Income:Crypto:Staking",
	exchangeIncome: "Income:Crypto:Exchange",
	exchangeExpenses: "Expenses:Crypto:Exchange",
	walletAssets: "Assets:Crypto:Wallet",
	walletEquity: "Equity:Crypto:Wallet",
	chainFees: "Expenses:Crypto:Fees",
	defiAssets: "Assets:Crypto:DeFi",
	defiLiabilities: "Liabilities:Crypto:DeFi",
	defiIncome: "Income:Crypto:DeFi",
	defiExpenses: "Expenses:Crypto:DeFi",
};

/** Required account-type prefix for each config key. */
export const PATH_TYPE_CONSTRAINTS: Readonly<Record<keyof AccountPathConfig, string>> = {
	bankAssets: "Assets:",
	bankFees: "Expenses:",
	creditCards: "Liabilities:",
	exchangeAssets: "Assets:",
	exchangeFees: "Expenses:",
	exchangeEquity: "Equity:",
	exchangeStaking: "Income:",
	exchangeIncome: "Income:",
	exchangeExpenses: "Expenses:",
	walletAssets: "Assets:",
	walletEquity: "Equity:",
	chainFees: "Expenses:",
	defiAssets: "Assets:",
	defiLiabilities: "Liabilities:",
	defiIncome: "Income:",
	defiExpenses: "Expenses:",
};

let _config: AccountPathConfig = { ...DEFAULT_PATH_CONFIG };

/**
 * Merge overrides into the active path config.
 * Pass `{}` to reset all prefixes to defaults.
 */
export function configureAccountPaths(overrides: Partial<AccountPathConfig>): void {
	_config = { ...DEFAULT_PATH_CONFIG, ...overrides };
}

/** Return a copy of the current path config. */
export function getAccountPathConfig(): AccountPathConfig {
	return { ..._config };
}

export interface PathConfigError {
	key: keyof AccountPathConfig;
	error: string;
}

/** Validate overrides against type constraints. Returns errors (empty = valid). */
export function validatePathConfig(overrides: Partial<AccountPathConfig>): PathConfigError[] {
	const errors: PathConfigError[] = [];
	for (const [k, v] of Object.entries(overrides)) {
		const key = k as keyof AccountPathConfig;
		const constraint = PATH_TYPE_CONSTRAINTS[key];
		if (constraint && !v.startsWith(constraint)) {
			errors.push({ key, error: `Must start with "${constraint}"` });
		}
		if (v.endsWith(":")) {
			errors.push({ key, error: "Must not end with \":\"" });
		}
		// Validate each segment is Beancount-compatible
		const invalidSegments = v.split(":").filter((s) => s && !validateAccountSegment(s));
		if (invalidSegments.length > 0) {
			errors.push({ key, error: `Invalid segment(s): ${invalidSegments.join(", ")}. Segments must start with a capital letter or digit, followed by letters, digits, or dashes.` });
		}
	}
	return errors;
}

// ── Account Segment Validation & Normalization ──────────
// Beancount rule: each segment starts with [A-Z0-9], followed by [A-Za-z0-9-]

const SEGMENT_RE = /^[A-Z0-9][A-Za-z0-9-]*$/;

/** Check whether a single account path segment is Beancount-valid. */
export function validateAccountSegment(segment: string): boolean {
	return SEGMENT_RE.test(segment);
}

/** Check whether a full colon-separated account path is Beancount-valid. */
export function validateAccountPath(path: string): boolean {
	if (!path) return false;
	const segments = path.split(":");
	return segments.length >= 1 && segments.every(validateAccountSegment);
}

/**
 * Normalize a single segment to Beancount-compatible form (CamelCase).
 * - Splits on non-alphanumeric-non-dash chars (spaces, underscores, dots, etc.)
 * - Capitalizes the first letter of each word, joins without separator
 * - Strips remaining invalid characters
 * - Returns "Unknown" if result is empty
 */
export function normalizeAccountSegment(segment: string): string {
	const trimmed = segment.trim();
	if (!trimmed) return "Unknown";

	// Split on anything that isn't alphanumeric or dash
	const words = trimmed.split(/[^A-Za-z0-9-]+/).filter(Boolean);
	if (words.length === 0) return "Unknown";

	// CamelCase: capitalize first letter of each word
	const camel = words
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join("");

	// Strip any remaining invalid chars (keep letters, digits, dashes)
	const cleaned = camel.replace(/[^A-Za-z0-9-]/g, "");

	// Collapse consecutive dashes, strip leading/trailing dashes
	const collapsed = cleaned.replace(/-{2,}/g, "-").replace(/^-|-$/g, "");

	if (!collapsed) return "Unknown";

	// Ensure first char is uppercase letter or digit
	if (/^[a-z]/.test(collapsed)) {
		return collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
	}
	return collapsed;
}

/**
 * Normalize a segment that may contain colons (producing multiple path levels).
 * Splits on ":", normalizes each part, rejoins.
 */
function n(s: string): string {
	return s.includes(":")
		? s.split(":").map(normalizeAccountSegment).join(":")
		: normalizeAccountSegment(s);
}

// ── Shared Fallback Constants (NOT configurable) ───────
export const EXPENSES_UNCATEGORIZED = "Expenses:Uncategorized";
export const INCOME_UNCATEGORIZED = "Income:Uncategorized";
export const ASSETS_BANK_IMPORT = "Assets:Bank:Import";
export const ASSETS_IMPORT = "Assets:Import";
export const EQUITY_OPENING = "Equity:Opening";
export const EQUITY_EXTERNAL = "Equity:External";
export const EQUITY_TRADING = "Equity:Trading";
export const EQUITY_TRADING_PREFIX = "Equity:Trading:";

// ── Bank Accounts ────────────────────────────────────
export function bankAssets(name: string): string;
export function bankAssets(name: string, suffix: string): string;
export function bankAssets(name: string, suffix?: string): string {
	return suffix ? `${_config.bankAssets}:${n(name)}:${n(suffix)}` : `${_config.bankAssets}:${n(name)}`;
}
export function bankFees(name: string) {
	return `${_config.bankFees}:${n(name)}`;
}
export function creditCard(last4: string) {
	return `${_config.creditCards}:${n(last4)}`;
}

// ── Crypto Exchange ──────────────────────────────────
export function exchangeAssets(name: string) {
	return `${_config.exchangeAssets}:${n(name)}`;
}
export function exchangeAssetsCurrency(name: string, currency: string) {
	return `${_config.exchangeAssets}:${n(name)}:${n(currency)}`;
}
export function exchangeFees(name: string) {
	return `${_config.exchangeFees}:${n(name)}`;
}
export function exchangeExternal(name: string) {
	return `${_config.exchangeEquity}:${n(name)}:External`;
}
export function exchangeStaking(name: string) {
	return `${_config.exchangeStaking}:${n(name)}`;
}
export function exchangeRewards(name: string) {
	return `${_config.exchangeIncome}:${n(name)}:Rewards`;
}
export function exchangeIncome(name: string, type: string) {
	return `${_config.exchangeIncome}:${n(name)}:${n(type)}`;
}
export function exchangeExpense(name: string, type: string) {
	return `${_config.exchangeExpenses}:${n(name)}:${n(type)}`;
}

// ── Crypto Wallet / On-chain ─────────────────────────
export function walletAssets(chain: string, label: string) {
	return `${_config.walletAssets}:${n(chain)}:${n(label)}`;
}
export function walletExternal(chain: string, addr: string) {
	return `${_config.walletEquity}:${n(chain)}:External:${n(addr)}`;
}
export function chainFees(chain: string) {
	return `${_config.chainFees}:${n(chain)}`;
}

// ── DeFi Protocol ────────────────────────────────────
export function defiAssets(protocol: string, type: string) {
	return `${_config.defiAssets}:${n(protocol)}:${n(type)}`;
}
export function defiLiabilities(protocol: string, type: string) {
	return `${_config.defiLiabilities}:${n(protocol)}:${n(type)}`;
}
export function defiIncome(protocol: string, type: string) {
	return `${_config.defiIncome}:${n(protocol)}:${n(type)}`;
}
export function defiExpense(protocol: string, type: string) {
	return `${_config.defiExpenses}:${n(protocol)}:${n(type)}`;
}
export function defiIncomePrefix(protocol: string) {
	return `${_config.defiIncome}:${n(protocol)}:`;
}
export function defiExpensePrefix(protocol: string) {
	return `${_config.defiExpenses}:${n(protocol)}:`;
}

// ── Trading / Cost-Basis ─────────────────────────────
export function tradingAccount(commodity: string) {
	return `Equity:Trading:${n(commodity)}`;
}

// ── Utilities ────────────────────────────────────────

/** Extract a meaningful bank name from an account path.
 *  e.g. "Assets:Bank:N26" → "N26", "Assets:Bank:Checking:1234" → "Checking" */
export function bankNameFromAccount(accountPath: string): string {
	const parts = accountPath.split(":");
	// Skip "Assets" and "Bank" (or similar) prefixes — return the first meaningful segment after them
	if (parts.length >= 3) return parts[2];
	if (parts.length >= 2) return parts[1];
	return parts[0] || "";
}
