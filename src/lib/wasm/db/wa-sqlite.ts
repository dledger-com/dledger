/**
 * wa-sqlite wrapper for dledger. Provides a typed async interface over
 * wa-sqlite with IDBBatchAtomicVFS for IndexedDB persistence.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SCHEMA_SQL, SCHEMA_VERSION, PLUGIN_KV_SCHEMA } from "./schema.js";

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

// wa-sqlite API type (return type of Factory)
type SQLiteAPI = any;

export class WaSqliteDb {
  private sqlite3!: SQLiteAPI;
  private db!: number;
  private initialized = false;
  private SQLITE_ROW!: number;

  /** Initialize the database. Must be called before any queries. */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Dynamic imports for browser-only modules
    const [factoryMod, SQLite, vfsMod] = await Promise.all([
      import("wa-sqlite/dist/wa-sqlite-async.mjs"),
      import("wa-sqlite"),
      import("wa-sqlite/src/examples/IDBBatchAtomicVFS.js"),
    ]);

    const SQLiteESMFactory = factoryMod.default;
    const IDBBatchAtomicVFS = vfsMod.IDBBatchAtomicVFS;
    this.SQLITE_ROW = SQLite.SQLITE_ROW;

    const module = await SQLiteESMFactory();
    this.sqlite3 = SQLite.Factory(module);

    const vfs = new IDBBatchAtomicVFS("dledger-vfs");
    this.sqlite3.vfs_register(vfs, true);

    this.db = await this.sqlite3.open_v2("dledger.db");

    // Apply schema
    await this.exec(SCHEMA_SQL);
    await this.exec(PLUGIN_KV_SCHEMA);

    // Check/set schema version
    const rows = await this.query<{ version: number }>(
      "SELECT version FROM schema_version LIMIT 1",
    );
    if (rows.length === 0) {
      await this.exec("INSERT INTO schema_version (version) VALUES (?1)", [
        SCHEMA_VERSION,
      ]);
    }

    this.initialized = true;
  }

  /** Execute SQL that doesn't return rows (INSERT, UPDATE, DELETE, DDL). */
  async exec(sql: string, params?: SqlValue[]): Promise<void> {
    if (params && params.length > 0) {
      for await (const stmt of this.sqlite3.statements(this.db, sql)) {
        this.sqlite3.bind_collection(stmt, params);
        await this.sqlite3.step(stmt);
      }
    } else {
      await this.sqlite3.exec(this.db, sql);
    }
  }

  /** Execute SQL and return all matching rows as objects. */
  async query<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T[]> {
    const results: T[] = [];
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      if (params && params.length > 0) {
        this.sqlite3.bind_collection(stmt, params);
      }
      const columns: string[] = this.sqlite3.column_names(stmt);
      while ((await this.sqlite3.step(stmt)) === this.SQLITE_ROW) {
        const values: SqlValue[] = this.sqlite3.row(stmt);
        const row: SqlRow = {};
        for (let i = 0; i < columns.length; i++) {
          row[columns[i]] = values[i];
        }
        results.push(row as T);
      }
    }
    return results;
  }

  /** Execute SQL and return the first matching row, or null. */
  async queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlValue[],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /** Get the number of rows changed by the last INSERT/UPDATE/DELETE. */
  changes(): number {
    return this.sqlite3.changes(this.db);
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    if (this.initialized) {
      await this.sqlite3.close(this.db);
      this.initialized = false;
    }
  }
}

/** Singleton database instance. */
let dbInstance: WaSqliteDb | null = null;

/** Get or create the singleton database instance. */
export async function getDb(): Promise<WaSqliteDb> {
  if (!dbInstance) {
    dbInstance = new WaSqliteDb();
    await dbInstance.init();
  }
  return dbInstance;
}
