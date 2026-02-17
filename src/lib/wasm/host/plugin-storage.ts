/**
 * Creates a plugin-storage host implementation backed by wa-sqlite.
 * Mirrors src-tauri/src/plugin/storage.rs.
 */

import type { WaSqliteDb } from "../db/wa-sqlite.js";
import type { PluginStorageImports } from "./types.js";

/**
 * Creates an async-capable plugin-storage implementation.
 * With jco --instantiation async, host imports can be async.
 */
export function createAsyncPluginStorage(
  db: WaSqliteDb,
  pluginId: string,
): PluginStorageImports {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl: any = {
    async get(key: string): Promise<string | undefined> {
      const row = await db.queryOne(
        "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND key = ?2",
        [pluginId, key],
      );
      return row ? (row.value as string) : undefined;
    },

    async set(key: string, value: string): Promise<void> {
      await db.exec(
        `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = ?3`,
        [pluginId, key, value],
      );
    },

    async delete(key: string): Promise<void> {
      await db.exec(
        "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND key = ?2",
        [pluginId, key],
      );
    },

    async listKeys(): Promise<string[]> {
      const rows = await db.query(
        "SELECT key FROM plugin_kv WHERE plugin_id = ?1 ORDER BY key",
        [pluginId],
      );
      return rows.map((r) => r.key as string);
    },
  };
  return impl as PluginStorageImports;
}
