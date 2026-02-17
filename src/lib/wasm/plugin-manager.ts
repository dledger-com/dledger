/**
 * Browser plugin manager. Loads jco-transpiled WASM plugins, provides
 * host imports, and executes handler/source operations.
 *
 * Mirrors src-tauri/src/plugin/manager.rs.
 *
 * Host imports are synchronous (backed by pre-loaded in-memory data) to
 * avoid JSPI memory issues. Only http-client uses JSPI for async fetch().
 * Data is pre-loaded from wa-sqlite before plugin execution and flushed after.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { v7 as uuidv7 } from "uuid";
import type { WaSqliteDb } from "./db/wa-sqlite.js";
import type {
  ConfigField as WitConfigField,
  HandlerExports,
  HandlerImports,
  SourceExports,
  SourceImports,
} from "./host/types.js";
import { createSyncHttpClient } from "./host/http-client.js";
import { createLogging } from "./host/logging.js";
import {
  createSyncPluginStorage,
  createSyncLedgerWrite,
  createSyncLedgerRead,
  type SyncPluginStorageState,
  type SyncLedgerWriteState,
  type SyncLedgerReadState,
} from "./host/sync-hosts.js";
import { fromDeclaration, type GrantedCapabilities } from "./host/capabilities.js";
import { ALL_PLUGINS, type PluginManifest } from "./plugin-registry.js";
import type { ConfigField, Extension } from "$lib/types/extension.js";

/** Convert jco camelCase ConfigField to frontend snake_case ConfigField. */
function toFrontendConfigField(f: WitConfigField): ConfigField {
  return {
    key: f.key,
    label: f.label,
    field_type: f.fieldType,
    required: f.required,
    default_value: f.defaultValue,
    description: f.description,
    options: f.options,
  };
}

interface LoadedPlugin {
  manifest: PluginManifest;
  caps: GrantedCapabilities;
  config: [string, string][];
}

export class BrowserPluginManager {
  private db: WaSqliteDb;
  private plugins = new Map<string, LoadedPlugin>();

  constructor(db: WaSqliteDb) {
    this.db = db;
    // Pre-register all known plugins
    for (const manifest of ALL_PLUGINS) {
      this.plugins.set(manifest.id, {
        manifest,
        caps: fromDeclaration(manifest.capabilities),
        config: [],
      });
    }
  }

  /** Discover available plugins (returns all bundled plugins). */
  discoverPlugins(): Extension[] {
    return this.listPlugins();
  }

  /** List all known plugins. */
  listPlugins(): Extension[] {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      kind: p.manifest.kind,
      enabled: true,
      capabilities: {
        ledger_read: p.caps.ledgerRead,
        ledger_write: p.caps.ledgerWrite,
        http: p.caps.http,
        allowed_domains: Array.from(p.caps.allowedDomains),
      },
    }));
  }

  /** Get config schema by instantiating the plugin. */
  async getConfigSchema(pluginId: string): Promise<ConfigField[]> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);

    const storageState = await this.preloadPluginStorage(pluginId);

    if (plugin.manifest.kind === "source") {
      const instance = await this.instantiateSource(pluginId, plugin, storageState);
      const fields = instance.sourceOps.configSchema();
      return (fields as WitConfigField[]).map(toFrontendConfigField);
    }
    const instance = await this.instantiateHandler(pluginId, plugin, storageState);
    const fields = instance.handlerOps.configSchema();
    return (fields as WitConfigField[]).map(toFrontendConfigField);
  }

  /** Configure a plugin with user-provided key-value pairs. */
  async configurePlugin(
    pluginId: string,
    config: [string, string][],
  ): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);

    const storageState = await this.preloadPluginStorage(pluginId);

    if (plugin.manifest.kind === "source") {
      const instance = await this.instantiateSource(pluginId, plugin, storageState);
      instance.sourceOps.configure(config);
    } else {
      const instance = await this.instantiateHandler(pluginId, plugin, storageState);
      instance.handlerOps.configure(config);
    }
    plugin.config = config;

    // Flush storage changes to DB
    await this.flushPluginStorage(pluginId, storageState);
  }

  /** Sync a source plugin. Returns summary string. */
  async syncPlugin(pluginId: string): Promise<string> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);
    if (plugin.manifest.kind !== "source")
      throw new Error(`Plugin '${pluginId}' is not a source plugin`);

    // Pre-load data from DB
    const storageState = await this.preloadPluginStorage(pluginId);
    const writeState = await this.preloadLedgerWriteState();

    const instance = await this.instantiateSource(pluginId, plugin, storageState, writeState);

    // Restore config
    if (plugin.config.length > 0) {
      instance.sourceOps.configure(plugin.config);
    }

    // Load previous sync cursor from storage state
    const prevCursor = storageState.data.get("__sync_cursor__") ?? "";

    // Run sync (all host imports are synchronous — no JSPI)
    const result = instance.sourceOps.sync({ cursor: prevCursor });
    const syncResult = result as any;

    // Flush ledger writes FIRST — if this fails, cursor stays unchanged
    await this.flushLedgerWrites(writeState);

    // Only persist cursor after ledger writes succeed
    if (syncResult.newState?.cursor) {
      storageState.data.set("__sync_cursor__", syncResult.newState.cursor);
      storageState.dirty = true;
    }
    await this.flushPluginStorage(pluginId, storageState);

    return syncResult.summary;
  }

  /** Run a handler plugin's process function. */
  async runHandler(pluginId: string, params: string): Promise<string> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);
    if (plugin.manifest.kind !== "handler")
      throw new Error(`Plugin '${pluginId}' is not a handler plugin`);

    const storageState = await this.preloadPluginStorage(pluginId);
    const instance = await this.instantiateHandler(pluginId, plugin, storageState);

    // Restore config
    if (plugin.config.length > 0) {
      instance.handlerOps.configure(plugin.config);
    }

    const result = instance.handlerOps.process(params);
    await this.flushPluginStorage(pluginId, storageState);
    return result as string;
  }

  /** Reset a plugin's sync cursor so the next sync re-imports from scratch. */
  async resetPluginSync(pluginId: string): Promise<void> {
    await this.db.exec(
      "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND key = '__sync_cursor__'",
      [pluginId],
    );
  }

  /** Generate a report from a handler plugin. */
  async generateReport(
    pluginId: string,
    format: string,
    params: string,
  ): Promise<number[]> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' not found`);
    if (plugin.manifest.kind !== "handler")
      throw new Error(`Plugin '${pluginId}' is not a handler plugin`);

    const storageState = await this.preloadPluginStorage(pluginId);
    const instance = await this.instantiateHandler(pluginId, plugin, storageState);

    if (plugin.config.length > 0) {
      instance.handlerOps.configure(plugin.config);
    }

    const bytes = instance.handlerOps.generateReport(format, params);
    await this.flushPluginStorage(pluginId, storageState);
    return Array.from(bytes as Uint8Array);
  }

  // ---- Pre-loading ----

  /** Load all KV pairs for a plugin into an in-memory Map. */
  private async preloadPluginStorage(
    pluginId: string,
  ): Promise<SyncPluginStorageState> {
    const rows = await this.db.query(
      "SELECT key, value FROM plugin_kv WHERE plugin_id = ?1",
      [pluginId],
    );
    const data = new Map<string, string>();
    for (const r of rows) {
      data.set(r.key as string, r.value as string);
    }
    return { data, dirty: false };
  }

  /** Pre-load existing accounts for ledger-write. */
  private async preloadLedgerWriteState(): Promise<SyncLedgerWriteState> {
    const rows = await this.db.query(
      "SELECT id, full_name FROM account",
    );
    const accountMap = new Map<string, string>();
    for (const r of rows) {
      accountMap.set(r.full_name as string, r.id as string);
    }
    return {
      accountMap,
      newAccounts: [],
      transactions: [],
      prices: [],
    };
  }

  /** Pre-load ledger data for handler plugins (ledger-read). */
  private async preloadLedgerReadState(): Promise<SyncLedgerReadState> {
    // Accounts
    const accountRows = await this.db.query(
      "SELECT id, full_name, account_type, is_postable FROM account ORDER BY full_name",
    );
    const accounts = accountRows.map((r) => ({
      id: r.id as string,
      fullName: r.full_name as string,
      accountType: r.account_type as string,
      isPostable: (r.is_postable as number) !== 0,
    }));
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    // Journal entries with line items
    const entryRows = await this.db.query(
      "SELECT id, date, description FROM journal_entry ORDER BY date",
    );
    const entries = [];
    for (const e of entryRows) {
      const items = await this.db.query(
        "SELECT account_id, currency, amount FROM line_item WHERE journal_entry_id = ?1",
        [e.id as string],
      );
      entries.push({
        id: e.id as string,
        date: e.date as string,
        description: e.description as string,
        items: items.map((li) => ({
          accountId: li.account_id as string,
          currency: li.currency as string,
          amount: li.amount as string,
        })),
      });
    }

    // Exchange rates
    const rateRows = await this.db.query(
      "SELECT from_currency, to_currency, date, rate FROM exchange_rate ORDER BY date",
    );
    const exchangeRates = rateRows.map((r) => ({
      fromCurrency: r.from_currency as string,
      toCurrency: r.to_currency as string,
      date: r.date as string,
      rate: r.rate as string,
    }));

    // Closure table
    const closureRows = await this.db.query(
      "SELECT ancestor_id, descendant_id FROM account_closure",
    );
    const closureMap = new Map<string, string[]>();
    for (const r of closureRows) {
      const ancestor = r.ancestor_id as string;
      const descendant = r.descendant_id as string;
      const list = closureMap.get(ancestor) ?? [];
      list.push(descendant);
      closureMap.set(ancestor, list);
    }

    return { accounts, accountMap, entries, exchangeRates, closureMap };
  }

  // ---- Flushing ----

  /** Flush plugin storage changes back to DB. */
  private async flushPluginStorage(
    pluginId: string,
    state: SyncPluginStorageState,
  ): Promise<void> {
    if (!state.dirty) return;

    // Delete all existing KV pairs and re-insert
    await this.db.exec(
      "DELETE FROM plugin_kv WHERE plugin_id = ?1",
      [pluginId],
    );
    for (const [key, value] of state.data) {
      await this.db.exec(
        "INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?1, ?2, ?3)",
        [pluginId, key, value],
      );
    }
  }

  /** Flush collected ledger writes to DB. */
  private async flushLedgerWrites(state: SyncLedgerWriteState): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    // Auto-create any currencies referenced by transactions/prices that don't exist yet
    const referencedCurrencies = new Set<string>();
    for (const tx of state.transactions) {
      for (const p of tx.postings) {
        referencedCurrencies.add(p.currency);
      }
    }
    for (const pp of state.prices) {
      referencedCurrencies.add(pp.fromCurrency);
      referencedCurrencies.add(pp.toCurrency);
    }
    for (const code of referencedCurrencies) {
      await this.db.exec(
        `INSERT OR IGNORE INTO currency (code, name, decimal_places, is_base)
         VALUES (?1, ?2, ?3, 0)`,
        [code, code, code === "BTC" ? 8 : code === "ETH" ? 18 : 2],
      );
    }

    // Create new accounts
    for (const acct of state.newAccounts) {
      await this.db.exec(
        `INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        [acct.id, acct.parentId, acct.accountType, acct.name, acct.fullName, "[]", 1, 0, today],
      );

      // Closure table: self-reference
      await this.db.exec(
        "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
        [acct.id, acct.id],
      );
      // Copy parent's ancestors
      if (acct.parentId) {
        await this.db.exec(
          `INSERT INTO account_closure (ancestor_id, descendant_id, depth)
           SELECT ancestor_id, ?1, depth + 1
           FROM account_closure WHERE descendant_id = ?2`,
          [acct.id, acct.parentId],
        );
      }

      // Audit log
      await this.db.exec(
        `INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [uuidv7(), today, "create", "account", acct.id, acct.fullName],
      );
    }

    // Write transactions
    for (const tx of state.transactions) {
      await this.db.exec(
        `INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [tx.entryId, tx.date, tx.description, "pending", tx.source, null, today],
      );

      for (const p of tx.postings) {
        await this.db.exec(
          `INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [p.id, tx.entryId, p.accountId, p.currency, p.amount, null],
        );
      }

      await this.db.exec(
        `INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [uuidv7(), today, "post", "journal_entry", tx.entryId, tx.description],
      );
    }

    // Write prices
    for (const pp of state.prices) {
      await this.db.exec(
        `INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [pp.id, pp.date, pp.fromCurrency, pp.toCurrency, pp.rate, pp.source],
      );
    }
  }

  // ---- Plugin instantiation ----

  /**
   * Instantiate a handler plugin with synchronous host imports.
   */
  private async instantiateHandler(
    pluginId: string,
    plugin: LoadedPlugin,
    storageState: SyncPluginStorageState,
  ): Promise<HandlerExports> {
    const pluginModule = await this.loadPluginModule(pluginId);
    const readState = await this.preloadLedgerReadState();
    const imports = this.buildSyncHandlerImports(pluginId, plugin, storageState, readState);
    const getCoreModule = this.makeCoreModuleLoader(pluginId);

    const instance = await pluginModule.instantiate(getCoreModule, imports);
    return instance as HandlerExports;
  }

  /**
   * Instantiate a source plugin. Uses sync imports for DB, async (JSPI) for HTTP.
   */
  private async instantiateSource(
    pluginId: string,
    plugin: LoadedPlugin,
    storageState: SyncPluginStorageState,
    writeState?: SyncLedgerWriteState,
  ): Promise<SourceExports> {
    const pluginModule = await this.loadPluginModule(pluginId);
    const ws = writeState ?? await this.preloadLedgerWriteState();
    const imports = this.buildSyncSourceImports(pluginId, plugin, storageState, ws);
    const getCoreModule = this.makeCoreModuleLoader(pluginId);

    const instance = await pluginModule.instantiate(getCoreModule, imports);
    return instance as SourceExports;
  }

  /** Create the getCoreModule callback for a plugin. */
  private makeCoreModuleLoader(
    pluginId: string,
  ): (path: string) => Promise<WebAssembly.Module> {
    return async (path: string): Promise<WebAssembly.Module> => {
      const wasmUrl = new URL(
        `./plugins/${pluginId}/${path}`,
        import.meta.url,
      ).href;
      const response = await fetch(wasmUrl);
      return WebAssembly.compileStreaming(response);
    };
  }

  /** Load the transpiled plugin ESM module. */
  private async loadPluginModule(
    pluginId: string,
  ): Promise<{ instantiate: (...args: any[]) => Promise<any> }> {
    const modules: Record<string, () => Promise<any>> = {
      "cost-basis": () => import("./plugins/cost-basis/plugin.js"),
      "missing-info": () => import("./plugins/missing-info/plugin.js"),
      "tax-report-fr": () => import("./plugins/tax-report-fr/plugin.js"),
      "export-beancount": () => import("./plugins/export-beancount/plugin.js"),
      "export-hledger": () => import("./plugins/export-hledger/plugin.js"),
      "csv-import": () => import("./plugins/csv-import/plugin.js"),
      "kraken": () => import("./plugins/kraken/plugin.js"),
      "etherscan": () => import("./plugins/etherscan/plugin.js"),
      "mempool": () => import("./plugins/mempool/plugin.js"),
    };

    const loader = modules[pluginId];
    if (!loader) throw new Error(`No transpiled module for plugin '${pluginId}'`);
    return loader();
  }

  /** Build the WASI shim imports shared by all plugins. */
  private buildWasiImports() {
    return {
      "wasi:cli/environment": {
        getEnvironment: () => [],
      },
      "wasi:cli/exit": {
        exit: (status: { tag: string; val?: number }) => {
          if (status.tag === "err") {
            throw new Error(`Plugin exited with error: ${status.val}`);
          }
        },
      },
      "wasi:cli/stderr": {
        getStderr: () => ({
          write(bytes: Uint8Array) {
            console.error(new TextDecoder().decode(bytes));
            return { tag: "ok", val: BigInt(bytes.length) };
          },
          blockingWriteAndFlush(bytes: Uint8Array) {
            console.error(new TextDecoder().decode(bytes));
          },
        }),
      },
      "wasi:io/error": {
        Error: class WasiError extends Error {},
      },
      "wasi:io/streams": {
        InputStream: class InputStream {},
        OutputStream: class OutputStream {
          write(bytes: Uint8Array) {
            return { tag: "ok", val: BigInt(bytes.length) };
          }
          blockingWriteAndFlush(bytes: Uint8Array) {
            void bytes;
          }
        },
      },
    };
  }

  /** Build synchronous handler imports. */
  private buildSyncHandlerImports(
    pluginId: string,
    plugin: LoadedPlugin,
    storageState: SyncPluginStorageState,
    readState: SyncLedgerReadState,
  ): HandlerImports {
    return {
      "dledger:plugin/ledger-read": createSyncLedgerRead(readState),
      "dledger:plugin/logging": createLogging(plugin.manifest.name),
      "dledger:plugin/plugin-storage": createSyncPluginStorage(storageState),
      "dledger:plugin/types": {} as Record<string, never>,
      ...this.buildWasiImports(),
    };
  }

  /** Build source imports: sync for DB, async (JSPI) for HTTP. */
  private buildSyncSourceImports(
    pluginId: string,
    plugin: LoadedPlugin,
    storageState: SyncPluginStorageState,
    writeState: SyncLedgerWriteState,
  ): SourceImports {
    const imports: SourceImports = {
      "dledger:plugin/ledger-write": createSyncLedgerWrite(writeState, plugin.manifest.name),
      "dledger:plugin/logging": createLogging(plugin.manifest.name),
      "dledger:plugin/plugin-storage": createSyncPluginStorage(storageState),
      "dledger:plugin/types": {} as Record<string, never>,
      ...this.buildWasiImports(),
    };

    // Add ledger-read if the plugin has that capability
    if (plugin.caps.ledgerRead) {
      // For source plugins, use a sync ledger-read based on pre-loaded write state
      // (accounts from the write state, which includes existing accounts)
      const accounts = Array.from(writeState.accountMap.entries()).map(([fullName, id]) => ({
        id,
        fullName,
        accountType: "asset", // simplified; exact type not critical for source plugins
        isPostable: true,
      }));
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      imports["dledger:plugin/ledger-read"] = createSyncLedgerRead({
        accounts,
        accountMap,
        entries: [],
        exchangeRates: [],
        closureMap: new Map(),
      });
    }

    // Add http-client if the plugin has that capability (synchronous via XMLHttpRequest)
    if (plugin.caps.http) {
      imports["dledger:plugin/http-client"] = createSyncHttpClient(
        plugin.caps,
        plugin.manifest.name,
      );
    }

    return imports;
  }
}
