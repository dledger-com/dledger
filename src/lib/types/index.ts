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
}

export interface ChainInfo {
  chain_id: number;
  name: string;
  native_currency: string;
  decimals: number;
}

export const SUPPORTED_CHAINS: ChainInfo[] = [
  { chain_id: 1,      name: "Ethereum",  native_currency: "ETH",  decimals: 18 },
  { chain_id: 10,     name: "Optimism",  native_currency: "ETH",  decimals: 18 },
  { chain_id: 42161,  name: "Arbitrum",  native_currency: "ETH",  decimals: 18 },
  { chain_id: 8453,   name: "Base",      native_currency: "ETH",  decimals: 18 },
  { chain_id: 59144,  name: "Linea",     native_currency: "ETH",  decimals: 18 },
  { chain_id: 534352, name: "Scroll",    native_currency: "ETH",  decimals: 18 },
  { chain_id: 324,    name: "ZkSync",    native_currency: "ETH",  decimals: 18 },
  { chain_id: 81457,  name: "Blast",     native_currency: "ETH",  decimals: 18 },
  { chain_id: 56,     name: "BSC",       native_currency: "BNB",  decimals: 18 },
  { chain_id: 137,    name: "Polygon",   native_currency: "POL",  decimals: 18 },
  { chain_id: 43114,  name: "Avalanche", native_currency: "AVAX", decimals: 18 },
  { chain_id: 250,    name: "Fantom",    native_currency: "FTM",  decimals: 18 },
  { chain_id: 100,    name: "Gnosis",    native_currency: "xDAI", decimals: 18 },
];

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
