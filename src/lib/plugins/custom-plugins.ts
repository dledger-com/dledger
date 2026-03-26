// Custom plugin persistence via Backend.

import type { Backend } from "../backend.js";
import type { Plugin } from "./types.js";
import { getPluginManager } from "./manager.js";

export interface CustomPluginRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  source_code: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Load all enabled custom plugins from the database and register them.
 * Logs warnings for plugins that fail to load but does not throw.
 */
export async function loadCustomPlugins(backend: Backend): Promise<void> {
  let plugins: CustomPluginRecord[];
  try {
    plugins = await backend.listCustomPlugins();
  } catch {
    // Table might not exist yet (old schema)
    return;
  }

  const pm = getPluginManager();
  for (const record of plugins) {
    if (!record.enabled) continue;
    if (pm.getById(record.id)) continue; // already registered

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function("exports", record.source_code + "\nreturn exports;") as (exports: Record<string, unknown>) => Record<string, unknown>;
      const result = fn({});
      const plugin = result.plugin as Plugin | undefined;
      if (plugin) {
        pm.register(plugin);
      } else {
        console.warn(`Custom plugin "${record.id}" did not export a plugin object`);
      }
    } catch (e) {
      console.warn(`Failed to load custom plugin "${record.id}":`, e);
    }
  }
}

/**
 * Save a custom plugin to the database.
 */
export async function saveCustomPlugin(
  backend: Backend,
  plugin: Plugin,
  sourceCode: string,
): Promise<void> {
  const now = new Date().toISOString();
  const record: CustomPluginRecord = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description ?? "",
    source_code: sourceCode,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  await backend.saveCustomPlugin(record);
}
