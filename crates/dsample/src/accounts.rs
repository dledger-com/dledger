// Account path constants mirroring src/lib/accounts/paths.ts defaults.

// Top-level
pub const ASSETS: &str = "Assets";
pub const LIABILITIES: &str = "Liabilities";
pub const INCOME: &str = "Income";
pub const EXPENSES: &str = "Expenses";
pub const EQUITY: &str = "Equity";

// Banking
pub const BANK_CHECKING: &str = "Assets:Bank:Checking";
pub const BANK_SAVINGS: &str = "Assets:Bank:Savings";
pub const BANK_FEES: &str = "Expenses:Bank:Fees";
pub const CREDIT_CARD: &str = "Liabilities:CreditCards:Visa";

// Income
pub const INCOME_SALARY: &str = "Income:Salary";
pub const INCOME_FREELANCE: &str = "Income:Freelance";
pub const INCOME_INTEREST: &str = "Income:Interest";

// Expenses — personal
pub const EXPENSES_RENT: &str = "Expenses:Housing:Rent";
pub const EXPENSES_UTILITIES: &str = "Expenses:Housing:Utilities";
pub const EXPENSES_GROCERIES: &str = "Expenses:Food:Groceries";
pub const EXPENSES_RESTAURANTS: &str = "Expenses:Food:Restaurants";
pub const EXPENSES_TRANSPORT: &str = "Expenses:Transport";
pub const EXPENSES_SUBSCRIPTIONS: &str = "Expenses:Subscriptions";
pub const EXPENSES_SHOPPING: &str = "Expenses:Shopping";
pub const EXPENSES_HEALTH: &str = "Expenses:Health";
pub const EXPENSES_ENTERTAINMENT: &str = "Expenses:Entertainment";

// Crypto — exchange
pub const EXCHANGE_ASSETS_KRAKEN: &str = "Assets:Crypto:Exchange:Kraken";
pub const EXCHANGE_ASSETS_BINANCE: &str = "Assets:Crypto:Exchange:Binance";
pub const EXCHANGE_FEES: &str = "Expenses:Crypto:Fees:Trading";
pub const EXCHANGE_INCOME: &str = "Income:Crypto:Exchange";
pub const EXCHANGE_STAKING: &str = "Income:Crypto:Staking";

// Crypto — wallet
pub const WALLET_ASSETS_ETH: &str = "Assets:Crypto:Wallet:Ethereum:Main";
pub const WALLET_ASSETS_BTC: &str = "Assets:Crypto:Wallet:Bitcoin:Main";
pub const CHAIN_FEES_ETH: &str = "Expenses:Crypto:Fees:Ethereum";
pub const CHAIN_FEES_BTC: &str = "Expenses:Crypto:Fees:Bitcoin";

// Crypto — DeFi
pub const DEFI_ASSETS_UNISWAP: &str = "Assets:Crypto:DeFi:Uniswap:Liquidity";
pub const DEFI_ASSETS_AAVE: &str = "Assets:Crypto:DeFi:Aave:Lending";
pub const DEFI_INCOME: &str = "Income:Crypto:DeFi";
pub const DEFI_EXPENSES: &str = "Expenses:Crypto:DeFi";

// Equity
pub const EQUITY_TRADING: &str = "Equity:Trading";
pub const EQUITY_OPENING: &str = "Equity:Opening Balances";
pub const EQUITY_EXTERNAL: &str = "Equity:External";

/// All accounts used by the personal scenario.
pub fn personal_accounts() -> Vec<&'static str> {
    vec![
        BANK_CHECKING,
        BANK_SAVINGS,
        CREDIT_CARD,
        INCOME_SALARY,
        INCOME_FREELANCE,
        INCOME_INTEREST,
        EXPENSES_RENT,
        EXPENSES_UTILITIES,
        EXPENSES_GROCERIES,
        EXPENSES_RESTAURANTS,
        EXPENSES_TRANSPORT,
        EXPENSES_SUBSCRIPTIONS,
        EXPENSES_SHOPPING,
        EXPENSES_HEALTH,
        EXPENSES_ENTERTAINMENT,
        BANK_FEES,
        EQUITY_OPENING,
    ]
}

/// All accounts used by the crypto scenario.
pub fn crypto_accounts() -> Vec<&'static str> {
    vec![
        BANK_CHECKING,
        EXCHANGE_ASSETS_KRAKEN,
        EXCHANGE_ASSETS_BINANCE,
        EXCHANGE_FEES,
        EXCHANGE_INCOME,
        EXCHANGE_STAKING,
        WALLET_ASSETS_ETH,
        WALLET_ASSETS_BTC,
        CHAIN_FEES_ETH,
        CHAIN_FEES_BTC,
        DEFI_ASSETS_UNISWAP,
        DEFI_ASSETS_AAVE,
        DEFI_INCOME,
        DEFI_EXPENSES,
        EQUITY_TRADING,
        EQUITY_EXTERNAL,
        EQUITY_OPENING,
    ]
}
