// Load a user-provided plugin from source code.

import type { Plugin } from "../plugins/types.js";
import { getPluginManager } from "../plugins/manager.js";

export interface PluginLoadResult {
  success: boolean;
  plugin?: Plugin;
  error?: string;
}

/**
 * Evaluate user-provided code and extract a Plugin object.
 * The code is expected to set `exports.plugin = { ... }`.
 */
export function loadPluginFromCode(code: string): PluginLoadResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("exports", code + "\nreturn exports;") as (exports: Record<string, unknown>) => Record<string, unknown>;
    const result = fn({});

    const plugin = result.plugin as Plugin | undefined;
    if (!plugin) {
      return { success: false, error: "No `exports.plugin` found in the code. Make sure your code ends with `exports.plugin = plugin;`" };
    }

    if (!plugin.id || typeof plugin.id !== "string") {
      return { success: false, error: "Plugin must have a string `id` property." };
    }
    if (!plugin.name || typeof plugin.name !== "string") {
      return { success: false, error: "Plugin must have a string `name` property." };
    }
    if (!plugin.version || typeof plugin.version !== "string") {
      return { success: false, error: "Plugin must have a string `version` property." };
    }

    // Check it has at least one contribution
    const hasContributions =
      (plugin.csvPresets && plugin.csvPresets.length > 0) ||
      (plugin.cexAdapters && plugin.cexAdapters.length > 0) ||
      (plugin.transactionHandlers && plugin.transactionHandlers.length > 0) ||
      (plugin.pdfParsers && plugin.pdfParsers.length > 0) ||
      (plugin.rateSources && plugin.rateSources.length > 0) ||
      (plugin.solanaHandlers && plugin.solanaHandlers.length > 0);

    if (!hasContributions) {
      return { success: false, error: "Plugin must provide at least one contribution (csvPresets, cexAdapters, transactionHandlers, pdfParsers, rateSources, or solanaHandlers)." };
    }

    // Check for duplicate
    const pm = getPluginManager();
    if (pm.getById(plugin.id)) {
      return { success: false, error: `A plugin with id "${plugin.id}" is already registered.` };
    }

    // Register
    pm.register(plugin);

    return { success: true, plugin };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Code evaluation failed: ${message}` };
  }
}
