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
  OpenLot,
  Budget,
} from "./types/index.js";
import type { ExchangeAccount } from "./cex/types.js";
import type { LedgerFormat } from "./ledger-format.js";

export interface Reconciliation {
  id: string;
  account_id: string;
  statement_date: string;
  statement_balance: string;
  currency: string;
  reconciled_at: string;
  line_item_count: number;
}

export interface UnreconciledLineItem {
  line_item_id: string;
  entry_id: string;
  entry_date: string;
  entry_description: string;
  account_id: string;
  currency: string;
  amount: string;
  is_reconciled: boolean;
}

export interface RecurringTemplate {
  id: string;
  description: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  next_date: string;
  end_date: string | null;
  is_active: boolean;
  line_items: TemplateLineItem[];
  created_at: string;
}

export interface TemplateLineItem {
  account_id: string;
  currency: string;
  amount: string;
}

export interface CurrencyRateSource {
  currency: string;
  rate_source: string | null; // null = auto-detect needed
  set_by: string;             // "user" | "handler:<id>" | "auto"
  updated_at: string;
}

export interface CurrencyDateRequirement {
  currency: string;
  mode: "range" | "dates";
  firstDate: string;   // YYYY-MM-DD
  lastDate: string;
  hasBalance: boolean;  // net balance != 0 → extend to today
  dates: string[];      // populated when mode="dates"
}

export interface Backend {
  // Currencies
  listCurrencies(): Promise<Currency[]>;
  createCurrency(currency: Currency): Promise<void>;

  // Accounts
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  createAccount(account: Account): Promise<void>;
  archiveAccount(id: string): Promise<void>;
  updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean }): Promise<void>;

  // Journal entries
  postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void>;
  voidJournalEntry(id: string): Promise<JournalEntry>;
  getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null>;
  queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]>;
  countJournalEntries(filter: TransactionFilter): Promise<number>;

  // Balances
  getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;
  getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;

  // Reports
  trialBalance(asOf: string): Promise<TrialBalance>;
  incomeStatement(fromDate: string, toDate: string): Promise<IncomeStatement>;
  balanceSheet(asOf: string): Promise<BalanceSheet>;
  balanceSheetBatch(dates: string[]): Promise<Map<string, BalanceSheet>>;
  gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport>;
  listOpenLots(): Promise<OpenLot[]>;

  // Budgets
  createBudget(budget: Budget): Promise<void>;
  listBudgets(): Promise<Budget[]>;
  updateBudget(budget: Budget): Promise<void>;
  deleteBudget(id: string): Promise<void>;

  // Exchange rates
  recordExchangeRate(rate: ExchangeRate): Promise<void>;
  recordExchangeRateBatch?(rates: ExchangeRate[]): Promise<void>;
  getExchangeRate(from: string, to: string, date: string): Promise<string | null>;
  getExchangeRatesBatch?(pairs: { currency: string; date: string }[], baseCurrency: string): Promise<Map<string, boolean>>;
  getExchangeRatesBatchExact?(pairs: { currency: string; date: string }[], baseCurrency: string): Promise<Map<string, boolean>>;
  listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]>;

  // Auto-backfill: determine which currencies need rates and for which dates
  getCurrencyDateRequirements?(baseCurrency: string): Promise<CurrencyDateRequirement[]>;

  // Ledger file import/export
  importLedgerFile(content: string, format?: LedgerFormat): Promise<LedgerImportResult>;
  exportLedgerFile(format?: LedgerFormat): Promise<string>;

  // Etherscan
  listEtherscanAccounts(): Promise<EtherscanAccount[]>;
  addEtherscanAccount(address: string, chainId: number, label: string): Promise<void>;
  removeEtherscanAccount(address: string, chainId: number): Promise<void>;
  syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;

  // Exchange accounts (CEX)
  listExchangeAccounts(): Promise<ExchangeAccount[]>;
  addExchangeAccount(account: ExchangeAccount): Promise<void>;
  updateExchangeAccount(id: string, updates: Partial<ExchangeAccount>): Promise<void>;
  removeExchangeAccount(id: string): Promise<void>;

  // Metadata
  setMetadata(entryId: string, entries: Record<string, string>): Promise<void>;
  getMetadata(entryId: string): Promise<Record<string, string>>;
  queryEntriesByMetadata(key: string, value: string): Promise<string[]>;
  getAllTagValues(): Promise<string[]>;
  getAllMetadataKeys(): Promise<string[]>;

  // Batch metadata/links (for virtual scrolling visible-range loading)
  getMetadataBatch?(entryIds: string[]): Promise<Map<string, Record<string, string>>>;
  getEntryLinksBatch?(entryIds: string[]): Promise<Map<string, string[]>>;

  // Entry links
  setEntryLinks(entryId: string, links: string[]): Promise<void>;
  getEntryLinks(entryId: string): Promise<string[]>;
  getEntriesByLink(linkName: string): Promise<string[]>;
  getAllLinkNames(): Promise<string[]>;
  getAllLinksWithCounts(): Promise<Array<{ link_name: string; entry_count: number }>>;

  // Account metadata
  setAccountMetadata(accountId: string, entries: Record<string, string>): Promise<void>;
  getAccountMetadata(accountId: string): Promise<Record<string, string>>;

  // Raw transactions
  storeRawTransaction(source: string, data: string): Promise<void>;
  getRawTransaction(source: string): Promise<string | null>;
  queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>>;

  // Currency origins
  getCurrencyOrigins(): Promise<CurrencyOrigin[]>;

  // Currency rate source management
  getCurrencyRateSources(): Promise<CurrencyRateSource[]>;
  setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string): Promise<boolean>;
  clearAutoRateSources(): Promise<void>;
  clearNonUserRateSources(): Promise<void>;

  // Currency token addresses (for DeFi pricing via DefiLlama)
  setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void>;
  getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>>;
  getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null>;

  // Currency hidden management
  setCurrencyHidden(code: string, isHidden: boolean): Promise<void>;
  listHiddenCurrencies(): Promise<string[]>;

  // Balance assertions
  createBalanceAssertion(assertion: BalanceAssertion): Promise<void>;
  listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]>;
  checkBalanceAssertions(): Promise<BalanceAssertionResult[]>;

  // Integrity checks
  countOrphanedLineItems(): Promise<number>;
  countDuplicateSources(): Promise<number>;

  // Reconciliation
  getUnreconciledLineItems(accountId: string, currency: string, upToDate?: string): Promise<UnreconciledLineItem[]>;
  markReconciled(reconciliation: Reconciliation, lineItemIds: string[]): Promise<void>;
  listReconciliations(accountId?: string): Promise<Reconciliation[]>;
  getReconciliationDetail(id: string): Promise<{ reconciliation: Reconciliation; lineItemIds: string[] } | null>;

  // Recurring templates
  createRecurringTemplate(template: RecurringTemplate): Promise<void>;
  listRecurringTemplates(): Promise<RecurringTemplate[]>;
  updateRecurringTemplate(template: RecurringTemplate): Promise<void>;
  deleteRecurringTemplate(id: string): Promise<void>;

  // Database export/import (optional)
  exportDatabase?(): Promise<Uint8Array>;
  importDatabase?(data: Uint8Array): Promise<void>;

  // Transaction control (optional, SqlJsBackend only)
  beginTransaction?(): void;
  commitTransaction?(): void;
  rollbackTransaction?(): void;

  // Account rename / merge
  renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }>;
  mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; templates: number; metadata: number }>;

  // Data management
  clearExchangeRates(): Promise<void>;
  clearLedgerData(): Promise<void>;
  clearAllData(): Promise<void>;

  // Lifecycle
  close?(): void;
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
  async updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean }): Promise<void> {
    return this.invoke("update_account", { id, updates });
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
  async countJournalEntries(filter: TransactionFilter): Promise<number> {
    return this.invoke("count_journal_entries", { filter });
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
  async listOpenLots(): Promise<OpenLot[]> {
    return this.invoke("list_open_lots");
  }

  // Budgets
  async createBudget(budget: Budget): Promise<void> {
    return this.invoke("create_budget", { budget });
  }
  async listBudgets(): Promise<Budget[]> {
    return this.invoke("list_budgets");
  }
  async updateBudget(budget: Budget): Promise<void> {
    return this.invoke("update_budget", { budget });
  }
  async deleteBudget(id: string): Promise<void> {
    return this.invoke("delete_budget", { id });
  }

  // Reconciliation
  async getUnreconciledLineItems(accountId: string, currency: string, upToDate?: string): Promise<UnreconciledLineItem[]> {
    return this.invoke("get_unreconciled_line_items", { accountId, currency, upToDate: upToDate ?? null });
  }
  async markReconciled(reconciliation: Reconciliation, lineItemIds: string[]): Promise<void> {
    return this.invoke("mark_reconciled", { reconciliation, lineItemIds });
  }
  async listReconciliations(accountId?: string): Promise<Reconciliation[]> {
    return this.invoke("list_reconciliations", { accountId: accountId ?? null });
  }
  async getReconciliationDetail(id: string): Promise<{ reconciliation: Reconciliation; lineItemIds: string[] } | null> {
    return this.invoke("get_reconciliation_detail", { id });
  }

  // Recurring templates
  async createRecurringTemplate(template: RecurringTemplate): Promise<void> {
    return this.invoke("create_recurring_template", { template });
  }
  async listRecurringTemplates(): Promise<RecurringTemplate[]> {
    return this.invoke("list_recurring_templates");
  }
  async updateRecurringTemplate(template: RecurringTemplate): Promise<void> {
    return this.invoke("update_recurring_template", { template });
  }
  async deleteRecurringTemplate(id: string): Promise<void> {
    return this.invoke("delete_recurring_template", { id });
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
  async importLedgerFile(content: string, format?: LedgerFormat): Promise<LedgerImportResult> {
    return this.invoke("import_ledger_file", { content, format: format ?? null });
  }
  async exportLedgerFile(format?: LedgerFormat): Promise<string> {
    return this.invoke("export_ledger_file", { format: format ?? null });
  }

  // Metadata
  async setMetadata(entryId: string, entries: Record<string, string>): Promise<void> {
    return this.invoke("set_metadata", { entryId, entries });
  }
  async getMetadata(entryId: string): Promise<Record<string, string>> {
    return this.invoke("get_metadata", { entryId });
  }

  async queryEntriesByMetadata(key: string, value: string): Promise<string[]> {
    return this.invoke("query_entries_by_metadata", { key, value });
  }
  async getAllTagValues(): Promise<string[]> {
    return [];
  }
  async getAllMetadataKeys(): Promise<string[]> {
    return [];
  }

  // Batch metadata/links
  async getMetadataBatch(entryIds: string[]): Promise<Map<string, Record<string, string>>> {
    if (entryIds.length === 0) return new Map();
    const results = await Promise.all(entryIds.map(id => this.getMetadata(id)));
    const map = new Map<string, Record<string, string>>();
    for (let i = 0; i < entryIds.length; i++) {
      map.set(entryIds[i], results[i]);
    }
    return map;
  }

  async getEntryLinksBatch(entryIds: string[]): Promise<Map<string, string[]>> {
    if (entryIds.length === 0) return new Map();
    const results = await Promise.all(entryIds.map(id => this.getEntryLinks(id)));
    const map = new Map<string, string[]>();
    for (let i = 0; i < entryIds.length; i++) {
      map.set(entryIds[i], results[i]);
    }
    return map;
  }

  // Entry links
  async setEntryLinks(entryId: string, links: string[]): Promise<void> {
    return this.invoke("set_entry_links", { entryId, links });
  }
  async getEntryLinks(entryId: string): Promise<string[]> {
    return this.invoke("get_entry_links", { entryId });
  }
  async getEntriesByLink(linkName: string): Promise<string[]> {
    return this.invoke("get_entries_by_link", { linkName });
  }
  async getAllLinkNames(): Promise<string[]> {
    return this.invoke("get_all_link_names");
  }
  async getAllLinksWithCounts(): Promise<Array<{ link_name: string; entry_count: number }>> {
    return this.invoke("get_all_links_with_counts");
  }

  // Account metadata
  async setAccountMetadata(accountId: string, entries: Record<string, string>): Promise<void> {
    return this.invoke("set_account_metadata", { accountId, entries });
  }
  async getAccountMetadata(accountId: string): Promise<Record<string, string>> {
    return this.invoke("get_account_metadata", { accountId });
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

  // Exchange accounts (CEX)
  async listExchangeAccounts(): Promise<ExchangeAccount[]> {
    return this.invoke("list_exchange_accounts");
  }
  async addExchangeAccount(account: ExchangeAccount): Promise<void> {
    return this.invoke("add_exchange_account", { account });
  }
  async updateExchangeAccount(id: string, updates: Partial<ExchangeAccount>): Promise<void> {
    return this.invoke("update_exchange_account", { id, updates });
  }
  async removeExchangeAccount(id: string): Promise<void> {
    return this.invoke("remove_exchange_account", { id });
  }

  // Currency origins
  async getCurrencyOrigins(): Promise<CurrencyOrigin[]> {
    return this.invoke("get_currency_origins");
  }

  // Currency rate source management
  async getCurrencyRateSources(): Promise<CurrencyRateSource[]> {
    return this.invoke("get_currency_rate_sources");
  }
  async setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string): Promise<boolean> {
    await this.invoke("set_currency_rate_source", { currency, rateSource: rateSource ?? "", setBy });
    return true;
  }
  async clearAutoRateSources(): Promise<void> {
    return this.invoke("clear_auto_rate_sources");
  }
  async clearNonUserRateSources(): Promise<void> {
    return this.invoke("clear_non_user_rate_sources");
  }

  // Currency token addresses
  async setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void> {
    return this.invoke("set_currency_token_address", { currency, chain, contractAddress });
  }
  async getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>> {
    return this.invoke("get_currency_token_addresses");
  }
  async getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null> {
    return this.invoke("get_currency_token_address", { currency });
  }

  // Currency hidden management
  async setCurrencyHidden(code: string, isHidden: boolean): Promise<void> {
    return this.invoke("set_currency_hidden", { code, isHidden });
  }
  async listHiddenCurrencies(): Promise<string[]> {
    return this.invoke("list_hidden_currencies");
  }

  // Balance assertions
  async createBalanceAssertion(assertion: BalanceAssertion): Promise<void> {
    return this.invoke("create_balance_assertion", { assertion });
  }
  async listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]> {
    return this.invoke("list_balance_assertions", { accountId: accountId ?? null });
  }
  async checkBalanceAssertions(): Promise<BalanceAssertionResult[]> {
    const assertions: BalanceAssertion[] = await this.invoke("check_balance_assertions");
    return assertions.map(a => ({
      assertion: a,
      actual_balance: a.actual_balance ?? "0",
      is_passing: a.is_passing,
      difference: "0", // Computed client-side if needed
    }));
  }

  // Integrity checks
  async countOrphanedLineItems(): Promise<number> {
    return this.invoke("count_orphaned_line_items");
  }
  async countDuplicateSources(): Promise<number> {
    return this.invoke("count_duplicate_sources");
  }

  // Account rename / merge
  async renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }> {
    return this.invoke("rename_account_prefix", { oldPrefix, newPrefix });
  }
  async mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; templates: number; metadata: number }> {
    return this.invoke("merge_accounts", { sourceId, targetId });
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

// Store backend on globalThis so it survives Vite HMR module replacement.
// Without this, each HMR cycle creates a new WASM instance (~16MB) without
// freeing the old one, eventually causing WebAssembly OOM.
const _g = globalThis as unknown as {
  __dledger_backend?: Backend;
  __dledger_initPromise?: Promise<Backend>;
};

export async function initBackend(): Promise<Backend> {
  if (_g.__dledger_backend) return _g.__dledger_backend;
  if (_g.__dledger_initPromise) return _g.__dledger_initPromise;
  _g.__dledger_initPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).__TAURI_INTERNALS__) {
      _g.__dledger_backend = new TauriBackend();
    } else {
      const { SqlJsBackend } = await import("./sql-js-backend.js");
      _g.__dledger_backend = await SqlJsBackend.create();
    }
    return _g.__dledger_backend;
  })();
  return _g.__dledger_initPromise;
}

export function getBackend(): Backend {
  if (!_g.__dledger_backend) {
    throw new Error("Backend not initialized. Await initBackend() first.");
  }
  return _g.__dledger_backend;
}

export function disposeBackend(): void {
  const backend = _g.__dledger_backend;
  if (backend?.close) backend.close();
  _g.__dledger_backend = undefined;
  _g.__dledger_initPromise = undefined;
}
