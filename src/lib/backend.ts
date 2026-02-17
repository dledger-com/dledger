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
  ConfigField,
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
  getPluginConfigSchema(pluginId: string): Promise<ConfigField[]>;
  configurePlugin(pluginId: string, config: [string, string][]): Promise<void>;
  syncPlugin(pluginId: string): Promise<string>;
  runHandler(pluginId: string, params: string): Promise<string>;
  generateReport(pluginId: string, format: string, params: string): Promise<number[]>;
  resetPluginSync(pluginId: string): Promise<void>;

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
  async getPluginConfigSchema(pluginId: string): Promise<ConfigField[]> {
    return this.invoke("plugin_config_schema", { pluginId });
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
  async resetPluginSync(pluginId: string): Promise<void> {
    return this.invoke("reset_plugin_sync", { pluginId });
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
  private dbPromise: Promise<import("./wasm/db/wa-sqlite.js").WaSqliteDb> | null = null;
  private pluginMgrPromise: Promise<import("./wasm/plugin-manager.js").BrowserPluginManager> | null = null;

  private getDb(): Promise<import("./wasm/db/wa-sqlite.js").WaSqliteDb> {
    if (!this.dbPromise) {
      this.dbPromise = import("./wasm/db/wa-sqlite.js").then((m) => m.getDb());
    }
    return this.dbPromise;
  }

  private async getPluginManager(): Promise<import("./wasm/plugin-manager.js").BrowserPluginManager> {
    if (!this.pluginMgrPromise) {
      this.pluginMgrPromise = (async () => {
        const [db, { BrowserPluginManager }] = await Promise.all([
          this.getDb(),
          import("./wasm/plugin-manager.js"),
        ]);
        return new BrowserPluginManager(db);
      })();
    }
    return this.pluginMgrPromise;
  }

  private async q() {
    const [db, queries] = await Promise.all([
      this.getDb(),
      import("./wasm/db/queries.js"),
    ]);
    return { db, queries };
  }

  // Currencies
  async listCurrencies(): Promise<Currency[]> {
    const { db, queries } = await this.q();
    return queries.listCurrencies(db);
  }
  async createCurrency(currency: Currency): Promise<void> {
    const { db, queries } = await this.q();
    return queries.createCurrency(db, currency);
  }

  // Accounts
  async listAccounts(): Promise<Account[]> {
    const { db, queries } = await this.q();
    return queries.listAccounts(db);
  }
  async getAccount(id: string): Promise<Account | null> {
    const { db, queries } = await this.q();
    return queries.getAccount(db, id);
  }
  async createAccount(account: Account): Promise<void> {
    const { db, queries } = await this.q();
    return queries.createAccount(db, account);
  }
  async archiveAccount(id: string): Promise<void> {
    const { db, queries } = await this.q();
    return queries.archiveAccount(db, id);
  }

  // Journal entries
  async postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void> {
    const { db, queries } = await this.q();
    return queries.postJournalEntry(db, entry, items);
  }
  async voidJournalEntry(id: string): Promise<JournalEntry> {
    const { db, queries } = await this.q();
    return queries.voidJournalEntry(db, id);
  }
  async getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null> {
    const { db, queries } = await this.q();
    return queries.getJournalEntry(db, id);
  }
  async queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]> {
    const { db, queries } = await this.q();
    return queries.queryJournalEntries(db, filter);
  }

  // Balances
  async getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    const { db, queries } = await this.q();
    return queries.getAccountBalance(db, accountId, asOf);
  }
  async getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    const { db, queries } = await this.q();
    return queries.getAccountBalanceWithChildren(db, accountId, asOf);
  }

  // Reports
  async trialBalance(asOf: string): Promise<TrialBalance> {
    const { db, queries } = await this.q();
    return queries.trialBalance(db, asOf);
  }
  async incomeStatement(fromDate: string, toDate: string): Promise<IncomeStatement> {
    const { db, queries } = await this.q();
    return queries.incomeStatement(db, fromDate, toDate);
  }
  async balanceSheet(asOf: string): Promise<BalanceSheet> {
    const { db, queries } = await this.q();
    return queries.balanceSheet(db, asOf);
  }
  async gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport> {
    const { db, queries } = await this.q();
    return queries.gainLossReport(db, fromDate, toDate);
  }

  // CSV Import
  async importCsv(params: CsvImportParams): Promise<string> {
    const { db, queries } = await this.q();
    return queries.importCsv(db, params);
  }

  // Plugins — delegated to BrowserPluginManager
  async discoverPlugins(): Promise<Extension[]> {
    return this.listPlugins();
  }
  async listPlugins(): Promise<Extension[]> {
    const { ALL_PLUGINS } = await import("./wasm/plugin-registry.js");
    const { fromDeclaration } = await import("./wasm/host/capabilities.js");
    return ALL_PLUGINS.map((m) => {
      const caps = fromDeclaration(m.capabilities);
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        kind: m.kind,
        enabled: true,
        capabilities: {
          ledger_read: caps.ledgerRead,
          ledger_write: caps.ledgerWrite,
          http: caps.http,
          allowed_domains: Array.from(caps.allowedDomains),
        },
      };
    });
  }
  async getPluginConfigSchema(pluginId: string): Promise<ConfigField[]> {
    const mgr = await this.getPluginManager();
    return mgr.getConfigSchema(pluginId);
  }
  async configurePlugin(pluginId: string, config: [string, string][]): Promise<void> {
    const mgr = await this.getPluginManager();
    return mgr.configurePlugin(pluginId, config);
  }
  async syncPlugin(pluginId: string): Promise<string> {
    const mgr = await this.getPluginManager();
    return mgr.syncPlugin(pluginId);
  }
  async runHandler(pluginId: string, params: string): Promise<string> {
    const mgr = await this.getPluginManager();
    return mgr.runHandler(pluginId, params);
  }
  async generateReport(pluginId: string, format: string, params: string): Promise<number[]> {
    const mgr = await this.getPluginManager();
    return mgr.generateReport(pluginId, format, params);
  }
  async resetPluginSync(pluginId: string): Promise<void> {
    const mgr = await this.getPluginManager();
    return mgr.resetPluginSync(pluginId);
  }

  // Exchange rates
  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
    const { db, queries } = await this.q();
    return queries.recordExchangeRate(db, rate);
  }
  async getExchangeRate(from: string, to: string, date: string): Promise<string | null> {
    const { db, queries } = await this.q();
    return queries.getExchangeRate(db, from, to, date);
  }
  async listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]> {
    const { db, queries } = await this.q();
    return queries.listExchangeRates(db, from, to);
  }
}

let backend: Backend | null = null;

function detectMode(): "tauri" | "wasm" {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? "tauri"
    : "wasm";
}

export function initBackend(mode?: "tauri" | "wasm"): Backend {
  const m = mode ?? detectMode();
  backend = m === "wasm" ? new WasmBackend() : new TauriBackend();
  return backend;
}

export function getBackend(): Backend {
  if (!backend) {
    initBackend();
  }
  return backend!;
}
