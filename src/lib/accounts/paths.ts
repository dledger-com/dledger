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
	}
	return errors;
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
	return suffix ? `${_config.bankAssets}:${name}:${suffix}` : `${_config.bankAssets}:${name}`;
}
export function bankFees(name: string) {
	return `${_config.bankFees}:${name}`;
}
export function creditCard(last4: string) {
	return `${_config.creditCards}:${last4}`;
}

// ── Crypto Exchange ──────────────────────────────────
export function exchangeAssets(name: string) {
	return `${_config.exchangeAssets}:${name}`;
}
export function exchangeAssetsCurrency(name: string, currency: string) {
	return `${_config.exchangeAssets}:${name}:${currency}`;
}
export function exchangeFees(name: string) {
	return `${_config.exchangeFees}:${name}`;
}
export function exchangeExternal(name: string) {
	return `${_config.exchangeEquity}:${name}:External`;
}
export function exchangeStaking(name: string) {
	return `${_config.exchangeStaking}:${name}`;
}
export function exchangeRewards(name: string) {
	return `${_config.exchangeIncome}:${name}:Rewards`;
}
export function exchangeIncome(name: string, type: string) {
	return `${_config.exchangeIncome}:${name}:${type}`;
}
export function exchangeExpense(name: string, type: string) {
	return `${_config.exchangeExpenses}:${name}:${type}`;
}

// ── Crypto Wallet / On-chain ─────────────────────────
export function walletAssets(chain: string, label: string) {
	return `${_config.walletAssets}:${chain}:${label}`;
}
export function walletExternal(chain: string, addr: string) {
	return `${_config.walletEquity}:${chain}:External:${addr}`;
}
export function chainFees(chain: string) {
	return `${_config.chainFees}:${chain}`;
}

// ── DeFi Protocol ────────────────────────────────────
export function defiAssets(protocol: string, type: string) {
	return `${_config.defiAssets}:${protocol}:${type}`;
}
export function defiLiabilities(protocol: string, type: string) {
	return `${_config.defiLiabilities}:${protocol}:${type}`;
}
export function defiIncome(protocol: string, type: string) {
	return `${_config.defiIncome}:${protocol}:${type}`;
}
export function defiExpense(protocol: string, type: string) {
	return `${_config.defiExpenses}:${protocol}:${type}`;
}
export function defiIncomePrefix(protocol: string) {
	return `${_config.defiIncome}:${protocol}:`;
}
export function defiExpensePrefix(protocol: string) {
	return `${_config.defiExpenses}:${protocol}:`;
}

// ── Trading / Cost-Basis ─────────────────────────────
export function tradingAccount(commodity: string) {
	return `Equity:Trading:${commodity}`;
}
