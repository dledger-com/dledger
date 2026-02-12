import type {
  Account,
  Currency,
  JournalEntry,
  LineItem,
  TransactionFilter,
  CurrencyBalance,
  TrialBalance,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
  CsvImportParams,
  Extension,
  ExchangeRate,
} from "./types/index.js";

export interface Backend {
  // Currencies
  listCurrencies(): Promise<Currency[]>;
  createCurrency(currency: Currency): Promise<void>;

  // Accounts
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  createAccount(account: Account): Promise<void>;
  archiveAccount(id: string): Promise<void>;

  // Journal entries
  postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void>;
  voidJournalEntry(id: string): Promise<JournalEntry>;
  getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null>;
  queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]>;

  // Balances
  getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;
  getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;

  // Reports
  trialBalance(asOf: string): Promise<TrialBalance>;
  incomeStatement(fromDate: string, toDate: string): Promise<IncomeStatement>;
  balanceSheet(asOf: string): Promise<BalanceSheet>;
  gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport>;

  // CSV Import
  importCsv(params: CsvImportParams): Promise<string>;

  // Plugins
  discoverPlugins(): Promise<Extension[]>;
  listPlugins(): Promise<Extension[]>;
  configurePlugin(pluginId: string, config: [string, string][]): Promise<void>;
  syncPlugin(pluginId: string): Promise<string>;
  runHandler(pluginId: string, params: string): Promise<string>;
  generateReport(pluginId: string, format: string, params: string): Promise<number[]>;

  // Exchange rates (extended)
  recordExchangeRate(rate: ExchangeRate): Promise<void>;
  getExchangeRate(from: string, to: string, date: string): Promise<string | null>;
  listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]>;
}

class TauriBackend implements Backend {
  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  // Currencies
  async listCurrencies(): Promise<Currency[]> {
    return this.invoke("list_currencies");
  }
  async createCurrency(currency: Currency): Promise<void> {
    return this.invoke("create_currency", { currency });
  }

  // Accounts
  async listAccounts(): Promise<Account[]> {
    return this.invoke("list_accounts");
  }
  async getAccount(id: string): Promise<Account | null> {
    return this.invoke("get_account", { id });
  }
  async createAccount(account: Account): Promise<void> {
    return this.invoke("create_account", { account });
  }
  async archiveAccount(id: string): Promise<void> {
    return this.invoke("archive_account", { id });
  }

  // Journal entries
  async postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void> {
    return this.invoke("post_journal_entry", { entry, items });
  }
  async voidJournalEntry(id: string): Promise<JournalEntry> {
    return this.invoke("void_journal_entry", { id });
  }
  async getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null> {
    return this.invoke("get_journal_entry", { id });
  }
  async queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]> {
    return this.invoke("query_journal_entries", { filter });
  }

  // Balances
  async getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return this.invoke("get_account_balance", { accountId, asOf: asOf ?? null });
  }
  async getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return this.invoke("get_account_balance_with_children", { accountId, asOf: asOf ?? null });
  }

  // Reports
  async trialBalance(asOf: string): Promise<TrialBalance> {
    return this.invoke("trial_balance", { asOf });
  }
  async incomeStatement(fromDate: string, toDate: string): Promise<IncomeStatement> {
    return this.invoke("income_statement", { fromDate, toDate });
  }
  async balanceSheet(asOf: string): Promise<BalanceSheet> {
    return this.invoke("balance_sheet", { asOf });
  }
  async gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport> {
    return this.invoke("gain_loss_report", { fromDate, toDate });
  }

  async importCsv(params: CsvImportParams): Promise<string> {
    return this.invoke("import_csv", {
      csvData: params.csvData,
      account: params.account,
      contraAccount: params.contraAccount,
      currency: params.currency,
      dateColumn: params.dateColumn,
      descriptionColumn: params.descriptionColumn,
      amountColumn: params.amountColumn,
      dateFormat: params.dateFormat,
      skipHeader: params.skipHeader,
      delimiter: params.delimiter,
    });
  }

  // Plugins
  async discoverPlugins(): Promise<Extension[]> {
    return this.invoke("discover_plugins");
  }
  async listPlugins(): Promise<Extension[]> {
    return this.invoke("list_plugins");
  }
  async configurePlugin(pluginId: string, config: [string, string][]): Promise<void> {
    return this.invoke("configure_plugin", { pluginId, config });
  }
  async syncPlugin(pluginId: string): Promise<string> {
    return this.invoke("sync_plugin", { pluginId });
  }
  async runHandler(pluginId: string, params: string): Promise<string> {
    return this.invoke("run_handler_plugin", { pluginId, params });
  }
  async generateReport(pluginId: string, format: string, params: string): Promise<number[]> {
    return this.invoke("generate_report_plugin", { pluginId, format, params });
  }

  // Exchange rates (extended)
  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
    return this.invoke("record_exchange_rate", { rate });
  }
  async getExchangeRate(from: string, to: string, date: string): Promise<string | null> {
    return this.invoke("get_exchange_rate", { from, to, date });
  }
  async listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]> {
    return this.invoke("list_exchange_rates", { from: from ?? null, to: to ?? null });
  }
}

class WasmBackend implements Backend {
  private fail(): never {
    throw new Error("WasmBackend is not yet implemented");
  }
  listCurrencies(): Promise<Currency[]> { return this.fail(); }
  createCurrency(_c: Currency): Promise<void> { return this.fail(); }
  listAccounts(): Promise<Account[]> { return this.fail(); }
  getAccount(_id: string): Promise<Account | null> { return this.fail(); }
  createAccount(_a: Account): Promise<void> { return this.fail(); }
  archiveAccount(_id: string): Promise<void> { return this.fail(); }
  postJournalEntry(_e: JournalEntry, _i: LineItem[]): Promise<void> { return this.fail(); }
  voidJournalEntry(_id: string): Promise<JournalEntry> { return this.fail(); }
  getJournalEntry(_id: string): Promise<[JournalEntry, LineItem[]] | null> { return this.fail(); }
  queryJournalEntries(_f: TransactionFilter): Promise<[JournalEntry, LineItem[]][]> { return this.fail(); }
  getAccountBalance(_id: string, _d?: string): Promise<CurrencyBalance[]> { return this.fail(); }
  getAccountBalanceWithChildren(_id: string, _d?: string): Promise<CurrencyBalance[]> { return this.fail(); }
  trialBalance(_d: string): Promise<TrialBalance> { return this.fail(); }
  incomeStatement(_f: string, _t: string): Promise<IncomeStatement> { return this.fail(); }
  balanceSheet(_d: string): Promise<BalanceSheet> { return this.fail(); }
  gainLossReport(_f: string, _t: string): Promise<GainLossReport> { return this.fail(); }
  importCsv(_p: CsvImportParams): Promise<string> { return this.fail(); }
  discoverPlugins(): Promise<Extension[]> { return this.fail(); }
  listPlugins(): Promise<Extension[]> { return this.fail(); }
  configurePlugin(_pluginId: string, _config: [string, string][]): Promise<void> { return this.fail(); }
  syncPlugin(_pluginId: string): Promise<string> { return this.fail(); }
  runHandler(_pluginId: string, _params: string): Promise<string> { return this.fail(); }
  generateReport(_pluginId: string, _format: string, _params: string): Promise<number[]> { return this.fail(); }
  recordExchangeRate(_rate: ExchangeRate): Promise<void> { return this.fail(); }
  getExchangeRate(_from: string, _to: string, _date: string): Promise<string | null> { return this.fail(); }
  listExchangeRates(_from?: string, _to?: string): Promise<ExchangeRate[]> { return this.fail(); }
}

let backend: Backend | null = null;

export function initBackend(mode: "tauri" | "wasm" = "tauri"): Backend {
  if (mode === "wasm") {
    backend = new WasmBackend();
  } else {
    backend = new TauriBackend();
  }
  return backend;
}

export function getBackend(): Backend {
  if (!backend) {
    throw new Error("Backend not initialized. Call initBackend() first.");
  }
  return backend;
}
