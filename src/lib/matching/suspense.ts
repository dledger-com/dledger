import {
	EQUITY_TRADING_PREFIX,
	EQUITY_OPENING,
	EQUITY_EXTERNAL,
	EXPENSES_UNCATEGORIZED,
	INCOME_UNCATEGORIZED,
	ASSETS_BANK_IMPORT,
	ASSETS_IMPORT,
	getAccountPathConfig,
} from "../accounts/paths.js";

/**
 * Returns true if the given account name is a "suspense" / placeholder account
 * that should be eliminated when two entries are merged.
 *
 * Matches:
 * - `Equity:*:External*` (exchange/wallet external) but NOT `Equity:Trading:*` or `Equity:Opening`
 * - `Expenses:Uncategorized` / `Income:Uncategorized`
 * - `Assets:Bank:Import` / `Assets:Import`
 * - `Equity:External`
 */
export function isSuspenseAccount(accountName: string): boolean {
	// Fixed constants — always suspense
	if (
		accountName === EXPENSES_UNCATEGORIZED ||
		accountName === INCOME_UNCATEGORIZED ||
		accountName === ASSETS_BANK_IMPORT ||
		accountName === ASSETS_IMPORT ||
		accountName === EQUITY_EXTERNAL
	) {
		return true;
	}

	// Equity accounts with ":External" segment — but exclude Trading and Opening
	if (accountName.startsWith("Equity:")) {
		if (accountName.startsWith(EQUITY_TRADING_PREFIX)) return false;
		if (accountName === EQUITY_OPENING) return false;
		if (accountName.includes(":External")) return true;
	}

	// Configurable equity prefixes — check if they produce ":External" patterns
	const config = getAccountPathConfig();
	const equityPrefixes = [config.exchangeEquity, config.walletEquity];
	for (const prefix of equityPrefixes) {
		if (accountName.startsWith(prefix + ":") && accountName.includes(":External")) {
			return true;
		}
	}

	return false;
}

/** Returns true if the account name matches Expenses:*:Fees:* or any configured fee prefix. */
export function isFeeAccount(accountName: string): boolean {
	const config = getAccountPathConfig();
	const feePrefixes = [config.exchangeFees, config.bankFees, config.chainFees];
	for (const prefix of feePrefixes) {
		if (accountName === prefix || accountName.startsWith(prefix + ":")) {
			return true;
		}
	}
	// Generic fee pattern: any account containing ":Fees:" or ending with ":Fees"
	if (accountName.includes(":Fees:") || accountName.endsWith(":Fees")) {
		return true;
	}
	return false;
}
