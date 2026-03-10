import type { Plugin } from "./types.js";
import { IndexedHandlerRegistry } from "./indexed-handler-registry.js";
import { CsvPresetRegistry } from "../csv-presets/registry.js";
import { PdfParserRegistry } from "./pdf-parser-registry.js";
import { CexAdapterRegistry } from "./cex-adapter-registry.js";
import { RateSourceRegistry } from "./rate-source-registry.js";

import { builtinHandlerExtensions } from "./builtin/handlers.js";
import { builtinCsvPresets } from "./builtin/csv-presets.js";
import { builtinPdfParsers } from "./builtin/pdf-parsers.js";
import { builtinCexAdapters } from "./builtin/cex-adapters.js";

export class PluginManager {
  private plugins = new Map<string, Plugin>();

  readonly handlers: IndexedHandlerRegistry;
  readonly csvPresets: CsvPresetRegistry;
  readonly pdfParsers: PdfParserRegistry;
  readonly cexAdapters: CexAdapterRegistry;
  readonly rateSources: RateSourceRegistry;

  constructor() {
    this.handlers = new IndexedHandlerRegistry();
    this.csvPresets = new CsvPresetRegistry();
    this.pdfParsers = new PdfParserRegistry();
    this.cexAdapters = new CexAdapterRegistry();
    this.rateSources = new RateSourceRegistry();
  }

  /**
   * Register a plugin and wire all its contributions into sub-registries.
   */
  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);

    if (plugin.transactionHandlers) {
      for (const ext of plugin.transactionHandlers) {
        this.handlers.register(ext);
      }
    }

    if (plugin.csvPresets) {
      for (const preset of plugin.csvPresets) {
        this.csvPresets.register(preset);
      }
    }

    if (plugin.pdfParsers) {
      for (const parser of plugin.pdfParsers) {
        this.pdfParsers.register(parser);
      }
    }

    if (plugin.cexAdapters) {
      for (const adapter of plugin.cexAdapters) {
        this.cexAdapters.register(adapter);
      }
    }

    if (plugin.rateSources) {
      for (const source of plugin.rateSources) {
        this.rateSources.register(source);
      }
    }
  }

  getAll(): Plugin[] {
    return [...this.plugins.values()];
  }

  getById(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  get pluginCount(): number {
    return this.plugins.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: PluginManager | null = null;

/**
 * Get the global PluginManager singleton.
 * On first call, registers all builtin extensions.
 */
export function getPluginManager(): PluginManager {
  if (_instance) return _instance;

  const pm = new PluginManager();

  // Register builtin extensions as a single "builtin" plugin
  pm.register({
    id: "org.dledger.builtin",
    name: "Built-in Extensions",
    version: "1.0.0",
    description: "Core dledger handlers, presets, parsers, and adapters",
    transactionHandlers: builtinHandlerExtensions,
    csvPresets: builtinCsvPresets,
    pdfParsers: builtinPdfParsers,
    cexAdapters: builtinCexAdapters,
  });

  _instance = pm;
  return pm;
}

/**
 * Reset the singleton (for testing).
 */
export function resetPluginManager(): void {
  _instance = null;
}
