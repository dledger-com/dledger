import { describe, it, expect, afterEach } from "vitest";
import {
	configureAccountPaths,
	getAccountPathConfig,
	validatePathConfig,
	DEFAULT_PATH_CONFIG,
	bankAssets,
	bankFees,
	creditCard,
	exchangeAssets,
	exchangeAssetsCurrency,
	exchangeFees,
	exchangeExternal,
	exchangeStaking,
	exchangeRewards,
	exchangeIncome,
	exchangeExpense,
	walletAssets,
	walletExternal,
	chainFees,
	defiAssets,
	defiLiabilities,
	defiIncome,
	defiExpense,
	defiIncomePrefix,
	defiExpensePrefix,
	tradingAccount,
	EQUITY_TRADING,
	EXPENSES_UNCATEGORIZED,
	INCOME_UNCATEGORIZED,
} from "./paths.js";

afterEach(() => {
	// Reset to defaults so tests don't leak state
	configureAccountPaths({});
});

describe("configureAccountPaths", () => {
	it("defaults produce the expected hardcoded paths", () => {
		expect(exchangeAssets("Kraken")).toBe("Assets:Crypto:Exchange:Kraken");
		expect(bankAssets("N26")).toBe("Assets:Bank:N26");
		expect(defiIncome("Aave", "Interest")).toBe("Income:Crypto:DeFi:Aave:Interest");
	});

	it("overrides change builder output", () => {
		configureAccountPaths({ exchangeAssets: "Assets:Exchanges" });
		expect(exchangeAssets("Kraken")).toBe("Assets:Exchanges:Kraken");
		expect(exchangeAssetsCurrency("Kraken", "ETH")).toBe("Assets:Exchanges:Kraken:ETH");
	});

	it("unconfigured keys keep defaults", () => {
		configureAccountPaths({ bankAssets: "Assets:Banks" });
		expect(bankAssets("N26")).toBe("Assets:Banks:N26");
		// Others unchanged
		expect(exchangeAssets("Kraken")).toBe("Assets:Crypto:Exchange:Kraken");
		expect(defiAssets("Aave", "Supply")).toBe("Assets:Crypto:DeFi:Aave:Supply");
	});

	it("reset: passing {} restores all defaults", () => {
		configureAccountPaths({ exchangeAssets: "Assets:X" });
		expect(exchangeAssets("K")).toBe("Assets:X:K");
		configureAccountPaths({});
		expect(exchangeAssets("K")).toBe("Assets:Crypto:Exchange:K");
	});
});

describe("getAccountPathConfig", () => {
	it("returns a copy of the current config", () => {
		const cfg = getAccountPathConfig();
		expect(cfg).toEqual(DEFAULT_PATH_CONFIG);
		// Mutating the returned object shouldn't affect internals
		cfg.bankAssets = "MUTATED";
		expect(getAccountPathConfig().bankAssets).toBe(DEFAULT_PATH_CONFIG.bankAssets);
	});

	it("reflects overrides", () => {
		configureAccountPaths({ creditCards: "Liabilities:Cards" });
		expect(getAccountPathConfig().creditCards).toBe("Liabilities:Cards");
	});
});

describe("validatePathConfig", () => {
	it("passes valid overrides", () => {
		const errors = validatePathConfig({
			bankAssets: "Assets:Banks",
			exchangeFees: "Expenses:Trading:Fees",
			defiLiabilities: "Liabilities:DeFi",
		});
		expect(errors).toEqual([]);
	});

	it("catches wrong account type prefix", () => {
		const errors = validatePathConfig({ bankAssets: "Income:Bank" });
		expect(errors).toHaveLength(1);
		expect(errors[0].key).toBe("bankAssets");
		expect(errors[0].error).toContain('Must start with "Assets:"');
	});

	it("catches trailing colon", () => {
		const errors = validatePathConfig({ bankAssets: "Assets:Bank:" });
		expect(errors).toHaveLength(1);
		expect(errors[0].error).toContain("Must not end with");
	});

	it("reports multiple errors", () => {
		const errors = validatePathConfig({
			bankAssets: "Expenses:Bank",       // wrong type
			exchangeStaking: "Assets:Staking",  // wrong type
		});
		expect(errors).toHaveLength(2);
	});
});

describe("builder functions use config keys", () => {
	it("bankAssets with suffix", () => {
		configureAccountPaths({ bankAssets: "Assets:Banks" });
		expect(bankAssets("N26", "Savings")).toBe("Assets:Banks:N26:Savings");
	});

	it("bankFees", () => {
		configureAccountPaths({ bankFees: "Expenses:Banking" });
		expect(bankFees("N26")).toBe("Expenses:Banking:N26");
	});

	it("creditCard", () => {
		configureAccountPaths({ creditCards: "Liabilities:CC" });
		expect(creditCard("1234")).toBe("Liabilities:CC:1234");
	});

	it("exchangeFees", () => {
		configureAccountPaths({ exchangeFees: "Expenses:Fees" });
		expect(exchangeFees("Kraken")).toBe("Expenses:Fees:Kraken");
	});

	it("exchangeExternal uses exchangeEquity", () => {
		configureAccountPaths({ exchangeEquity: "Equity:Exchanges" });
		expect(exchangeExternal("Kraken")).toBe("Equity:Exchanges:Kraken:External");
	});

	it("exchangeStaking", () => {
		configureAccountPaths({ exchangeStaking: "Income:Staking" });
		expect(exchangeStaking("Kraken")).toBe("Income:Staking:Kraken");
	});

	it("exchangeRewards uses exchangeIncome", () => {
		configureAccountPaths({ exchangeIncome: "Income:Exchanges" });
		expect(exchangeRewards("Nexo")).toBe("Income:Exchanges:Nexo:Rewards");
	});

	it("exchangeIncome", () => {
		configureAccountPaths({ exchangeIncome: "Income:Exchanges" });
		expect(exchangeIncome("Nexo", "Interest")).toBe("Income:Exchanges:Nexo:Interest");
	});

	it("exchangeExpense", () => {
		configureAccountPaths({ exchangeExpenses: "Expenses:Exchanges" });
		expect(exchangeExpense("CryptoCom", "Fee")).toBe("Expenses:Exchanges:CryptoCom:Fee");
	});

	it("walletAssets", () => {
		configureAccountPaths({ walletAssets: "Assets:Wallets" });
		expect(walletAssets("Ethereum", "Main")).toBe("Assets:Wallets:Ethereum:Main");
	});

	it("walletExternal uses walletEquity", () => {
		configureAccountPaths({ walletEquity: "Equity:Wallets" });
		expect(walletExternal("Ethereum", "0xabc")).toBe("Equity:Wallets:Ethereum:External:0xabc");
	});

	it("chainFees", () => {
		configureAccountPaths({ chainFees: "Expenses:Gas" });
		expect(chainFees("Ethereum")).toBe("Expenses:Gas:Ethereum");
	});

	it("defiAssets", () => {
		configureAccountPaths({ defiAssets: "Assets:DeFi" });
		expect(defiAssets("Aave", "Supply")).toBe("Assets:DeFi:Aave:Supply");
	});

	it("defiLiabilities", () => {
		configureAccountPaths({ defiLiabilities: "Liabilities:DeFi" });
		expect(defiLiabilities("Aave", "Borrow")).toBe("Liabilities:DeFi:Aave:Borrow");
	});

	it("defiIncome + prefix", () => {
		configureAccountPaths({ defiIncome: "Income:DeFi" });
		expect(defiIncome("Aave", "Interest")).toBe("Income:DeFi:Aave:Interest");
		expect(defiIncomePrefix("Aave")).toBe("Income:DeFi:Aave:");
	});

	it("defiExpense + prefix", () => {
		configureAccountPaths({ defiExpenses: "Expenses:DeFi" });
		expect(defiExpense("Aave", "Interest")).toBe("Expenses:DeFi:Aave:Interest");
		expect(defiExpensePrefix("Aave")).toBe("Expenses:DeFi:Aave:");
	});
});

describe("constants remain unchanged", () => {
	it("structural constants are unaffected by config", () => {
		configureAccountPaths({ exchangeAssets: "Assets:X" });
		expect(EQUITY_TRADING).toBe("Equity:Trading");
		expect(EXPENSES_UNCATEGORIZED).toBe("Expenses:Uncategorized");
		expect(INCOME_UNCATEGORIZED).toBe("Income:Uncategorized");
		expect(tradingAccount("ETH")).toBe("Equity:Trading:ETH");
	});
});
