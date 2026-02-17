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
export type { Extension, ExtensionConfig, ConfigField, CsvImportParams } from "./extension.js";
