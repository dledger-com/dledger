export interface ExchangeRate {
  id: string;
  date: string;
  from_currency: string;
  to_currency: string;
  rate: string;
  source: string;
}

export type { Account, AccountType, Currency } from "./account.js";
export type {
  JournalEntry,
  JournalEntryStatus,
  LineItem,
  TransactionFilter,
  JournalEntryWithItems,
} from "./journal.js";
export type {
  CurrencyBalance,
  TrialBalance,
  TrialBalanceLine,
  IncomeStatement,
  ReportSection,
  BalanceSheet,
  GainLossReport,
  GainLossLine,
} from "./report.js";

export interface LedgerImportResult {
  accounts_created: number;
  currencies_created: number;
  transactions_imported: number;
  prices_imported: number;
  warnings: string[];
  /** Unique (currency, date) pairs from imported transactions for historical rate backfill. */
  transaction_currency_dates?: [string, string][];
}

export interface ChainInfo {
  chain_id: number;
  name: string;
  native_currency: string;
  decimals: number;
}

export const SUPPORTED_CHAINS: ChainInfo[] = [
  { chain_id: 1,      name: "Ethereum",        native_currency: "ETH",    decimals: 18 },
  { chain_id: 10,     name: "Optimism",        native_currency: "ETH",    decimals: 18 },
  { chain_id: 42161,  name: "Arbitrum",        native_currency: "ETH",    decimals: 18 },
  { chain_id: 8453,   name: "Base",            native_currency: "ETH",    decimals: 18 },
  { chain_id: 59144,  name: "Linea",           native_currency: "ETH",    decimals: 18 },
  { chain_id: 534352, name: "Scroll",          native_currency: "ETH",    decimals: 18 },
  { chain_id: 81457,  name: "Blast",           native_currency: "ETH",    decimals: 18 },
  { chain_id: 56,     name: "BSC",             native_currency: "BNB",    decimals: 18 },
  { chain_id: 137,    name: "Polygon",         native_currency: "POL",    decimals: 18 },
  { chain_id: 43114,  name: "Avalanche",       native_currency: "AVAX",   decimals: 18 },
  { chain_id: 100,    name: "Gnosis",          native_currency: "xDAI",   decimals: 18 },
  { chain_id: 50,     name: "XDC",             native_currency: "XDC",    decimals: 18 },
  { chain_id: 130,    name: "Unichain",        native_currency: "ETH",    decimals: 18 },
  { chain_id: 143,    name: "Monad",           native_currency: "MON",    decimals: 18 },
  { chain_id: 146,    name: "Sonic",           native_currency: "S",      decimals: 18 },
  { chain_id: 199,    name: "BitTorrent Chain", native_currency: "BTT",   decimals: 18 },
  { chain_id: 204,    name: "opBNB",           native_currency: "BNB",    decimals: 18 },
  { chain_id: 252,    name: "Fraxtal",         native_currency: "frxETH", decimals: 18 },
  { chain_id: 480,    name: "World",           native_currency: "ETH",    decimals: 18 },
  { chain_id: 988,    name: "Stable",          native_currency: "STABLE", decimals: 18 },
  { chain_id: 999,    name: "HyperEVM",        native_currency: "HYPE",   decimals: 18 },
  { chain_id: 1284,   name: "Moonbeam",        native_currency: "GLMR",   decimals: 18 },
  { chain_id: 1285,   name: "Moonriver",       native_currency: "MOVR",   decimals: 18 },
  { chain_id: 1329,   name: "Sei",             native_currency: "SEI",    decimals: 18 },
  { chain_id: 1923,   name: "Swellchain",      native_currency: "ETH",    decimals: 18 },
  { chain_id: 2741,   name: "Abstract",        native_currency: "ETH",    decimals: 18 },
  { chain_id: 4326,   name: "MegaETH",         native_currency: "ETH",    decimals: 18 },
  { chain_id: 4352,   name: "Memecore",        native_currency: "MCORE",  decimals: 18 },
  { chain_id: 5000,   name: "Mantle",          native_currency: "MNT",    decimals: 18 },
  { chain_id: 9745,   name: "Plasma",          native_currency: "PLASMA", decimals: 18 },
  { chain_id: 33139,  name: "ApeChain",        native_currency: "APE",    decimals: 18 },
  { chain_id: 42220,  name: "Celo",            native_currency: "CELO",   decimals: 18 },
  { chain_id: 80094,  name: "Berachain",       native_currency: "BERA",   decimals: 18 },
  { chain_id: 167000, name: "Taiko",           native_currency: "ETH",    decimals: 18 },
  { chain_id: 747474, name: "Katana",          native_currency: "ETH",    decimals: 18 },
];

export interface BalanceAssertion {
  id: string;
  account_id: string;
  date: string;
  currency: string;
  expected_balance: string;
  is_passing: boolean;
  actual_balance: string | null;
}

export interface BalanceAssertionResult {
  assertion: BalanceAssertion;
  actual_balance: string;
  is_passing: boolean;
  difference: string;
}

export interface CurrencyOrigin {
  currency: string;
  origin: string;
}

export interface EtherscanAccount {
  address: string;
  chain_id: number;
  label: string;
}

export interface EtherscanSyncResult {
  transactions_imported: number;
  transactions_skipped: number;
  accounts_created: number;
  warnings: string[];
}

export interface OpenLot {
  id: string;
  account_id: string;
  account_name: string;
  currency: string;
  acquired_date: string;
  remaining_quantity: string;
  cost_basis_per_unit: string;
  cost_basis_currency: string;
  source_handler?: string | null;
}

export interface UnrealizedGainLossLine {
  currency: string;
  account_name: string;
  acquired_date: string;
  quantity: string;
  cost_basis_per_unit: string;
  cost_basis_currency: string;
  current_value: string;
  unrealized_gain_loss: string;
  source_handler?: string | null;
}

export interface UnrealizedGainLossReport {
  as_of: string;
  lines: UnrealizedGainLossLine[];
  total_unrealized: string;
  base_currency: string;
}

export interface Budget {
  id: string;
  account_pattern: string;
  period_type: "monthly" | "yearly";
  amount: string;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface BudgetComparison {
  budget: Budget;
  actual: number;
  remaining: number;
  percent_used: number;
}

export interface BudgetReport {
  from_date: string;
  to_date: string;
  comparisons: BudgetComparison[];
}
