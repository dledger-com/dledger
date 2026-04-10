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
import type { BitcoinAccount, BitcoinSyncResult } from "./bitcoin/types.js";
import type { ExchangeAccount } from "./cex/types.js";
import type { LedgerFormat } from "./ledger-format.js";
import type { LedgerImportOptions } from "./browser-ledger-file.js";
import type { PersistedFrenchTaxReport, FrenchTaxReport } from "./utils/french-tax.js";
import type { CustomPluginRecord } from "./plugins/custom-plugins.js";

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

export interface CurrencyRateOverride {
  currency: string;
  rate_source: string;        // "none" = suppress fetching
  set_by: string;             // "user" | "handler:<id>"
  updated_at: string;
}

export interface RateFetchFailure {
  currency: string;
  source: string;
  last_attempted_at: string;
  consecutive_failures: number;
}

export interface CurrencyDateRequirement {
  currency: string;
  mode: "range" | "dates";
  firstDate: string;   // YYYY-MM-DD
  lastDate: string;
  hasBalance: boolean;  // net balance != 0 → extend to today
  dates: string[];      // populated when mode="dates"
}

// Static import: Vite inlines DEMO_MODE as a literal boolean here, so the
// `if (DEMO_MODE)` branch in initBackend() is statically dead in regular
// builds and the dynamic import to ./demo-backend.js gets eliminated.
// (A dynamic `await import("./demo.js")` would put DEMO_MODE behind a chunk
// split, breaking constant folding and leaving demo-backend.js shipped to
// production.)
import { DEMO_MODE } from "./demo.js";

export interface GenericBlockchainAccount {
  id: string;
  chain: string;
  address: string;
  label: string;
  cursor: string | null;
  last_sync: string | null;
  created_at: string;
  extra: Record<string, string> | null;
}

export interface Backend {
  // Currencies
  listCurrencies(): Promise<Currency[]>;
  createCurrency(currency: Currency): Promise<void>;
  setCurrencyAssetType(code: string, assetType: string): Promise<void>;

  // Accounts
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  createAccount(account: Account): Promise<void>;
  archiveAccount(id: string): Promise<void>;
  unarchiveAccount(id: string): Promise<void>;
  updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean; opened_at?: string | null }): Promise<void>;

  // Journal entries
  postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void>;
  voidJournalEntry(id: string): Promise<JournalEntry>;
  editJournalEntry(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string }>;
  getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null>;
  queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]>;
  queryJournalEntriesOnly?(filter: TransactionFilter, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<JournalEntry[]>;
  getLineItemsForEntries?(entryIds: string[]): Promise<Map<string, LineItem[]>>;
  getJournalChartAggregation?(filter: TransactionFilter): Promise<{ date: string; income: number; expense: number }[]>;
  countJournalEntries(filter: TransactionFilter): Promise<number>;

  // Balances
  getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;
  getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;

  // Reports
  trialBalance(asOf: string): Promise<TrialBalance>;
  incomeStatement(fromDate: string, toDate: string, signal?: AbortSignal): Promise<IncomeStatement>;
  balanceSheet(asOf: string, signal?: AbortSignal): Promise<BalanceSheet>;
  balanceSheetBatch(dates: string[], signal?: AbortSignal): Promise<Map<string, BalanceSheet>>;
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
  getExchangeRateCurrenciesOnDate?(date: string): Promise<string[]>;
  listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]>;

  // Auto-backfill: determine which currencies need rates and for which dates
  getCurrencyDateRequirements?(baseCurrency: string): Promise<CurrencyDateRequirement[]>;

  // Ledger file import/export
  importLedgerFile(content: string, format?: LedgerFormat, options?: LedgerImportOptions): Promise<LedgerImportResult>;
  exportLedgerFile(format?: LedgerFormat): Promise<string>;

  // Etherscan
  listEtherscanAccounts(): Promise<EtherscanAccount[]>;
  addEtherscanAccount(address: string, chainId: number, label: string): Promise<void>;
  removeEtherscanAccount(address: string, chainId: number): Promise<void>;
  syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;
  syncTheGraph(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;

  // Bitcoin
  listBitcoinAccounts(): Promise<BitcoinAccount[]>;
  addBitcoinAccount(account: Omit<BitcoinAccount, "last_sync">): Promise<void>;
  removeBitcoinAccount(id: string): Promise<void>;
  getBtcTrackedAddresses(accountId: string): Promise<string[]>;
  storeBtcDerivedAddresses(accountId: string, addresses: Array<{address: string; change: number; index: number}>): Promise<void>;
  updateBtcDerivationIndex(accountId: string, receiveIndex: number, changeIndex: number): Promise<void>;
  updateBitcoinAccountLabel(id: string, label: string): Promise<void>;
  syncBitcoin(account: BitcoinAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitcoinSyncResult>;

  // Generic blockchain accounts
  listBlockchainAccounts(chain: string): Promise<GenericBlockchainAccount[]>;
  addBlockchainAccount(account: Omit<GenericBlockchainAccount, "cursor" | "last_sync"> & { extra?: Record<string, string> | null }): Promise<void>;
  removeBlockchainAccount(id: string): Promise<void>;
  updateBlockchainAccountLabel(id: string, label: string): Promise<void>;
  updateBlockchainAccountCursor(id: string, cursor: string | null): Promise<void>;

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

  // Crypto asset info
  listCryptoAssetInfo(): Promise<Map<string, string>>;
  setCryptoAssetCoingeckoId(code: string, geckoId: string): Promise<void>;

  // Currency origins
  getCurrencyOrigins(): Promise<CurrencyOrigin[]>;

  // Currency rate override management
  getCurrencyRateOverrides(): Promise<CurrencyRateOverride[]>;
  setCurrencyRateOverride(currency: string, rateSource: string, setBy: string): Promise<boolean>;
  removeCurrencyRateOverride(currency: string): Promise<void>;

  // Rate fetch failure tracking
  getRateFetchFailures(): Promise<RateFetchFailure[]>;
  recordRateFetchFailure(currency: string, source: string): Promise<void>;
  clearRateFetchFailure(currency: string, source: string): Promise<void>;
  clearAllRateFetchFailures(): Promise<void>;

  // Currency tracking + stale management
  setTracksCurrency(code: string, tracksCode: string | null): Promise<void>;
  setSyncFullRange(code: string, enabled: boolean): Promise<void>;
  setCurrencyStale(code: string, isStale: boolean): Promise<void>;

  // Currency token addresses (for DeFi pricing via DefiLlama)
  setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void>;
  getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>>;
  getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null>;

  // Currency management
  setCurrencyName(code: string, name: string): Promise<void>;
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

  // Database export/import (optional)
  exportDatabase?(): Promise<Uint8Array>;
  importDatabase?(data: Uint8Array): Promise<void>;

  // Transaction control (optional, SqlJsBackend only)
  beginTransaction?(): void;
  commitTransaction?(): void;
  rollbackTransaction?(): void;

  // Account rename / merge
  renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }>;
  mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; metadata: number }>;

  // French tax reports
  saveFrenchTaxReport(taxYear: number, report: FrenchTaxReport, checklist?: Record<string, boolean>): Promise<void>;
  getFrenchTaxReport(taxYear: number): Promise<PersistedFrenchTaxReport | null>;
  listFrenchTaxReportYears(): Promise<number[]>;
  deleteFrenchTaxReport(taxYear: number): Promise<void>;

  // Custom plugins
  listCustomPlugins(): Promise<CustomPluginRecord[]>;
  saveCustomPlugin(plugin: CustomPluginRecord): Promise<void>;
  deleteCustomPlugin(id: string): Promise<void>;
  setCustomPluginEnabled(id: string, enabled: boolean): Promise<void>;

  // Database repair
  repairDatabase(): Promise<string[]>;

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
  async setCurrencyAssetType(code: string, assetType: string): Promise<void> {
    return this.invoke("set_currency_asset_type", { code, assetType });
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
  async unarchiveAccount(id: string): Promise<void> {
    return this.invoke("unarchive_account", { id });
  }
  async updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean; opened_at?: string | null }): Promise<void> {
    return this.invoke("update_account", { id, updates });
  }

  // Journal entries
  async postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void> {
    return this.invoke("post_journal_entry", { entry, items });
  }
  async voidJournalEntry(id: string): Promise<JournalEntry> {
    return this.invoke("void_journal_entry", { id });
  }
  async editJournalEntry(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string }> {
    return this.invoke("edit_journal_entry", {
      originalId,
      newEntry,
      newItems,
      newMetadata: newMetadata ?? {},
      newLinks: newLinks ?? null,
    });
  }
  async getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null> {
    return this.invoke("get_journal_entry", { id });
  }
  async queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]> {
    return this.invoke("query_journal_entries", { filter });
  }
  async queryJournalEntriesOnly(filter: TransactionFilter): Promise<JournalEntry[]> {
    // Tauri backend: fall back to queryJournalEntries and strip line items
    const pairs = await this.queryJournalEntries(filter);
    return pairs.map(([e]) => e);
  }
  async getLineItemsForEntries(entryIds: string[]): Promise<Map<string, LineItem[]>> {
    // Tauri backend: fetch each entry individually
    const map = new Map<string, LineItem[]>();
    for (const id of entryIds) {
      const result = await this.getJournalEntry(id);
      if (result) map.set(id, result[1]);
    }
    return map;
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
  async getExchangeRateCurrenciesOnDate(date: string): Promise<string[]> {
    return this.invoke("get_exchange_rate_currencies_on_date", { date });
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
  async syncTheGraph(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult> {
    const { syncTheGraphWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncTheGraphWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
  }

  // Bitcoin
  async listBitcoinAccounts(): Promise<BitcoinAccount[]> {
    return this.invoke("list_bitcoin_accounts");
  }
  async addBitcoinAccount(account: Omit<BitcoinAccount, "last_sync">): Promise<void> {
    return this.invoke("add_bitcoin_account", { account });
  }
  async removeBitcoinAccount(id: string): Promise<void> {
    return this.invoke("remove_bitcoin_account", { id });
  }
  async getBtcTrackedAddresses(accountId: string): Promise<string[]> {
    return this.invoke("get_btc_tracked_addresses", { accountId });
  }
  async storeBtcDerivedAddresses(accountId: string, addresses: Array<{address: string; change: number; index: number}>): Promise<void> {
    return this.invoke("store_btc_derived_addresses", { accountId, addresses });
  }
  async updateBtcDerivationIndex(accountId: string, receiveIndex: number, changeIndex: number): Promise<void> {
    return this.invoke("update_btc_derivation_index", { accountId, receiveIndex, changeIndex });
  }
  async updateBitcoinAccountLabel(id: string, label: string): Promise<void> {
    return this.invoke("update_bitcoin_account_label", { id, label });
  }
  async syncBitcoin(account: BitcoinAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitcoinSyncResult> {
    const { syncBitcoinAccount } = await import("./bitcoin/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    const allAccounts = await this.listBitcoinAccounts();
    return syncBitcoinAccount(this, account, allAccounts, loadSettings(), onProgress, signal);
  }

  // Generic blockchain accounts
  async listBlockchainAccounts(chain: string): Promise<GenericBlockchainAccount[]> { return this.invoke("list_blockchain_accounts", { chain }); }
  async addBlockchainAccount(account: Omit<GenericBlockchainAccount, "cursor" | "last_sync">): Promise<void> { return this.invoke("add_blockchain_account", { account }); }
  async removeBlockchainAccount(id: string): Promise<void> { return this.invoke("remove_blockchain_account", { id }); }
  async updateBlockchainAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_blockchain_account_label", { id, label }); }
  async updateBlockchainAccountCursor(id: string, cursor: string | null): Promise<void> { return this.invoke("update_blockchain_account_cursor", { id, cursor }); }

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
  // Crypto asset info
  async listCryptoAssetInfo(): Promise<Map<string, string>> { return this.invoke("list_crypto_asset_info"); }
  async setCryptoAssetCoingeckoId(code: string, geckoId: string): Promise<void> { return this.invoke("set_crypto_asset_coingecko_id", { code, geckoId }); }

  async getCurrencyOrigins(): Promise<CurrencyOrigin[]> {
    return this.invoke("get_currency_origins");
  }

  // Currency rate override management
  async getCurrencyRateOverrides(): Promise<CurrencyRateOverride[]> {
    return this.invoke("get_currency_rate_overrides");
  }
  async setCurrencyRateOverride(currency: string, rateSource: string, setBy: string): Promise<boolean> {
    await this.invoke("set_currency_rate_override", { currency, rateSource, setBy });
    return true;
  }
  async removeCurrencyRateOverride(currency: string): Promise<void> {
    return this.invoke("remove_currency_rate_override", { currency });
  }

  // Rate fetch failure tracking
  async getRateFetchFailures(): Promise<RateFetchFailure[]> {
    return this.invoke("get_rate_fetch_failures");
  }
  async recordRateFetchFailure(currency: string, source: string): Promise<void> {
    return this.invoke("record_rate_fetch_failure", { currency, source });
  }
  async clearRateFetchFailure(currency: string, source: string): Promise<void> {
    return this.invoke("clear_rate_fetch_failure", { currency, source });
  }
  async clearAllRateFetchFailures(): Promise<void> {
    return this.invoke("clear_all_rate_fetch_failures");
  }

  // Currency tracking + stale management
  async setTracksCurrency(code: string, tracksCode: string | null): Promise<void> {
    return this.invoke("set_tracks_currency", { code, tracksCode });
  }
  async setSyncFullRange(code: string, enabled: boolean): Promise<void> {
    return this.invoke("set_sync_full_range", { code, enabled });
  }
  async setCurrencyStale(code: string, isStale: boolean): Promise<void> {
    return this.invoke("set_currency_stale", { code, isStale });
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

  // Currency management
  async setCurrencyName(code: string, name: string): Promise<void> {
    return this.invoke("set_currency_name", { code, name });
  }
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
  async mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; metadata: number }> {
    return this.invoke("merge_accounts", { sourceId, targetId });
  }

  // French tax reports
  async saveFrenchTaxReport(taxYear: number, report: FrenchTaxReport, checklist?: Record<string, boolean>): Promise<void> {
    return this.invoke("save_french_tax_report", {
      taxYear,
      reportJson: JSON.stringify({ report, checklist: checklist ?? {} }),
      finalAcquisitionCost: report.finalAcquisitionCost,
    });
  }
  async getFrenchTaxReport(taxYear: number): Promise<PersistedFrenchTaxReport | null> {
    const result = await this.invoke<[string, string, string] | null>("get_french_tax_report", { taxYear });
    if (!result) return null;
    const [generatedAt, finalAcquisitionCost, reportJson] = result;
    const parsed = JSON.parse(reportJson);
    // Backward compat: old format stored bare FrenchTaxReport (has taxYear field)
    if (parsed.taxYear !== undefined) {
      return { generatedAt, finalAcquisitionCost, report: parsed, checklist: {} };
    }
    return { generatedAt, finalAcquisitionCost, report: parsed.report, checklist: parsed.checklist ?? {} };
  }
  async listFrenchTaxReportYears(): Promise<number[]> {
    return this.invoke("list_french_tax_report_years");
  }
  async deleteFrenchTaxReport(taxYear: number): Promise<void> {
    return this.invoke("delete_french_tax_report", { taxYear });
  }

  // Database repair
  async repairDatabase(): Promise<string[]> {
    return this.invoke("repair_database", {});
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

  // Custom plugins (not implemented in Tauri backend — browser-only feature)
  async listCustomPlugins(): Promise<CustomPluginRecord[]> { return []; }
  async saveCustomPlugin(_plugin: CustomPluginRecord): Promise<void> { /* noop */ }
  async deleteCustomPlugin(_id: string): Promise<void> { /* noop */ }
  async setCustomPluginEnabled(_id: string, _enabled: boolean): Promise<void> { /* noop */ }
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
    if (DEMO_MODE) {
      const { createDemoBackend } = await import("./demo-backend.js");
      _g.__dledger_backend = await createDemoBackend();
      return _g.__dledger_backend;
    }
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
