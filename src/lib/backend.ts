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
  ExchangeRate,
  LedgerImportResult,
  EtherscanAccount,
  EtherscanSyncResult,
  CurrencyOrigin,
  BalanceAssertion,
  BalanceAssertionResult,
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
  balanceSheetBatch(dates: string[]): Promise<Map<string, BalanceSheet>>;
  gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport>;

  // Exchange rates
  recordExchangeRate(rate: ExchangeRate): Promise<void>;
  recordExchangeRateBatch?(rates: ExchangeRate[]): Promise<void>;
  getExchangeRate(from: string, to: string, date: string): Promise<string | null>;
  getExchangeRatesBatch?(pairs: { currency: string; date: string }[], baseCurrency: string): Promise<Map<string, boolean>>;
  listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]>;

  // Ledger file import/export
  importLedgerFile(content: string): Promise<LedgerImportResult>;
  exportLedgerFile(): Promise<string>;

  // Etherscan
  listEtherscanAccounts(): Promise<EtherscanAccount[]>;
  addEtherscanAccount(address: string, chainId: number, label: string): Promise<void>;
  removeEtherscanAccount(address: string, chainId: number): Promise<void>;
  syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;

  // Metadata
  setMetadata(entryId: string, entries: Record<string, string>): Promise<void>;
  getMetadata(entryId: string): Promise<Record<string, string>>;

  // Raw transactions
  storeRawTransaction(source: string, data: string): Promise<void>;
  getRawTransaction(source: string): Promise<string | null>;
  queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>>;

  // Currency origins
  getCurrencyOrigins(): Promise<CurrencyOrigin[]>;

  // Currency handler ownership
  setCurrencyHandler(currency: string, handler: string): Promise<void>;
  getCurrencyHandlers(): Promise<Record<string, string>>;
  clearCurrencyHandlers(): Promise<void>;

  // Balance assertions
  createBalanceAssertion(assertion: BalanceAssertion): Promise<void>;
  listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]>;
  checkBalanceAssertions(): Promise<BalanceAssertionResult[]>;

  // Integrity checks
  countOrphanedLineItems(): Promise<number>;
  countDuplicateSources(): Promise<number>;

  // Transaction control (optional, SqlJsBackend only)
  beginTransaction?(): void;
  commitTransaction?(): void;
  rollbackTransaction?(): void;

  // Data management
  clearExchangeRates(): Promise<void>;
  clearLedgerData(): Promise<void>;
  clearAllData(): Promise<void>;
}

class TauriBackend implements Backend {
  private bridgeReady: Promise<void> | null = null;

  private waitForBridge(): Promise<void> {
    if (this.bridgeReady) return this.bridgeReady;
    this.bridgeReady = new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__TAURI_INTERNALS__) { resolve(); return; }
      let elapsed = 0;
      const poll = setInterval(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).__TAURI_INTERNALS__) { clearInterval(poll); resolve(); }
        else if ((elapsed += 50) >= 3000) { clearInterval(poll); reject(new Error("Tauri IPC bridge not available")); }
      }, 50);
    });
    return this.bridgeReady;
  }

  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    await this.waitForBridge();
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
  async balanceSheetBatch(dates: string[]): Promise<Map<string, BalanceSheet>> {
    const entries = await Promise.all(dates.map(async d => [d, await this.balanceSheet(d)] as const));
    return new Map(entries);
  }
  async gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport> {
    return this.invoke("gain_loss_report", { fromDate, toDate });
  }

  // Exchange rates
  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
    return this.invoke("record_exchange_rate", { rate });
  }
  async getExchangeRate(from: string, to: string, date: string): Promise<string | null> {
    return this.invoke("get_exchange_rate", { from, to, date });
  }
  async listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]> {
    return this.invoke("list_exchange_rates", { from: from ?? null, to: to ?? null });
  }

  // Ledger file import/export
  async importLedgerFile(content: string): Promise<LedgerImportResult> {
    return this.invoke("import_ledger_file", { content });
  }
  async exportLedgerFile(): Promise<string> {
    return this.invoke("export_ledger_file");
  }

  // Metadata
  async setMetadata(entryId: string, entries: Record<string, string>): Promise<void> {
    return this.invoke("set_metadata", { entryId, entries });
  }
  async getMetadata(entryId: string): Promise<Record<string, string>> {
    return this.invoke("get_metadata", { entryId });
  }

  // Raw transactions
  async storeRawTransaction(source: string, data: string): Promise<void> {
    return this.invoke("store_raw_transaction", { source, data });
  }
  async getRawTransaction(source: string): Promise<string | null> {
    return this.invoke("get_raw_transaction", { source });
  }
  async queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>> {
    return this.invoke("query_raw_transactions", { sourcePrefix });
  }

  // Etherscan
  async listEtherscanAccounts(): Promise<EtherscanAccount[]> {
    return this.invoke("list_etherscan_accounts");
  }
  async addEtherscanAccount(address: string, chainId: number, label: string): Promise<void> {
    return this.invoke("add_etherscan_account", { address, chainId, label });
  }
  async removeEtherscanAccount(address: string, chainId: number): Promise<void> {
    return this.invoke("remove_etherscan_account", { address, chainId });
  }
  async syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult> {
    const { syncEtherscanWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncEtherscanWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
  }

  // Currency origins
  async getCurrencyOrigins(): Promise<CurrencyOrigin[]> {
    return this.invoke("get_currency_origins");
  }

  // Currency handler ownership
  async setCurrencyHandler(_currency: string, _handler: string): Promise<void> {
    // Not yet implemented in Rust backend
  }
  async getCurrencyHandlers(): Promise<Record<string, string>> {
    return {};
  }
  async clearCurrencyHandlers(): Promise<void> {
    // Not yet implemented in Rust backend
  }

  // Balance assertions (not yet implemented in Rust backend)
  async createBalanceAssertion(_assertion: BalanceAssertion): Promise<void> {
    throw new Error("Balance assertions not yet supported in Tauri backend");
  }
  async listBalanceAssertions(_accountId?: string): Promise<BalanceAssertion[]> {
    return [];
  }
  async checkBalanceAssertions(): Promise<BalanceAssertionResult[]> {
    return [];
  }

  // Integrity checks (not yet implemented in Rust backend)
  async countOrphanedLineItems(): Promise<number> {
    return 0;
  }
  async countDuplicateSources(): Promise<number> {
    return 0;
  }

  // Data management
  async clearExchangeRates(): Promise<void> {
    return this.invoke("clear_exchange_rates");
  }
  async clearLedgerData(): Promise<void> {
    return this.invoke("clear_ledger_data");
  }
  async clearAllData(): Promise<void> {
    return this.invoke("clear_all_data");
  }
}

let backend: Backend | null = null;

export async function initBackend(): Promise<Backend> {
  if (backend) return backend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).__TAURI_INTERNALS__) {
    backend = new TauriBackend();
  } else {
    const { SqlJsBackend } = await import("./sql-js-backend.js");
    backend = await SqlJsBackend.create();
  }
  return backend;
}

export function getBackend(): Backend {
  if (!backend) {
    throw new Error("Backend not initialized. Await initBackend() first.");
  }
  return backend;
}
