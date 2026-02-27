// Centralized account path constants and builders.
// Single point of change for all account path strings used across the codebase.

// ── Shared Fallback Constants ────────────────────────
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
	return suffix ? `Assets:Bank:${name}:${suffix}` : `Assets:Bank:${name}`;
}
export function bankFees(name: string) {
	return `Expenses:Bank:Fees:${name}`;
}
export function creditCard(last4: string) {
	return `Liabilities:CreditCards:${last4}`;
}

// ── Crypto Exchange ──────────────────────────────────
export function exchangeAssets(name: string) {
	return `Assets:Crypto:Exchange:${name}`;
}
export function exchangeAssetsCurrency(name: string, currency: string) {
	return `Assets:Crypto:Exchange:${name}:${currency}`;
}
export function exchangeFees(name: string) {
	return `Expenses:Crypto:Fees:Trading:${name}`;
}
export function exchangeExternal(name: string) {
	return `Equity:Crypto:Exchange:${name}:External`;
}
export function exchangeStaking(name: string) {
	return `Income:Crypto:Staking:${name}`;
}
export function exchangeRewards(name: string) {
	return `Income:Crypto:Exchange:${name}:Rewards`;
}
export function exchangeIncome(name: string, type: string) {
	return `Income:Crypto:Exchange:${name}:${type}`;
}
export function exchangeExpense(name: string, type: string) {
	return `Expenses:Crypto:Exchange:${name}:${type}`;
}

// ── Crypto Wallet / On-chain ─────────────────────────
export function walletAssets(chain: string, label: string) {
	return `Assets:Crypto:Wallet:${chain}:${label}`;
}
export function walletExternal(chain: string, addr: string) {
	return `Equity:Crypto:Wallet:${chain}:External:${addr}`;
}
export function chainFees(chain: string) {
	return `Expenses:Crypto:Fees:${chain}`;
}

// ── DeFi Protocol ────────────────────────────────────
export function defiAssets(protocol: string, type: string) {
	return `Assets:Crypto:DeFi:${protocol}:${type}`;
}
export function defiLiabilities(protocol: string, type: string) {
	return `Liabilities:Crypto:DeFi:${protocol}:${type}`;
}
export function defiIncome(protocol: string, type: string) {
	return `Income:Crypto:DeFi:${protocol}:${type}`;
}
export function defiExpense(protocol: string, type: string) {
	return `Expenses:Crypto:DeFi:${protocol}:${type}`;
}
export function defiIncomePrefix(protocol: string) {
	return `Income:Crypto:DeFi:${protocol}:`;
}
export function defiExpensePrefix(protocol: string) {
	return `Expenses:Crypto:DeFi:${protocol}:`;
}

// ── Trading / Cost-Basis ─────────────────────────────
export function tradingAccount(commodity: string) {
	return `Equity:Trading:${commodity}`;
}
