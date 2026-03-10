import { getPluginManager } from "../plugins/manager.js";
import type { IndexedHandlerRegistry } from "../plugins/indexed-handler-registry.js";

export { HandlerRegistry } from "./registry.js";
export { syncEtherscanWithHandlers, dryRunReprocess, applyReprocess } from "./pipeline.js";
export type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  HandlerEntry,
} from "./types.js";
export type { ReprocessOptions, ReprocessResult, ReprocessChange } from "./pipeline.js";

/**
 * Get the default handler registry backed by the PluginManager.
 * Returns the IndexedHandlerRegistry from the global PluginManager singleton.
 */
export function getDefaultRegistry(): IndexedHandlerRegistry {
  return getPluginManager().handlers;
}
