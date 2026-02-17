/**
 * Creates a logging host implementation that routes to console.*.
 * Mirrors src-tauri/src/plugin/host_impl.rs logging section.
 */

import type { LoggingImports } from "./types.js";

export function createLogging(pluginName: string): LoggingImports {
  const prefix = `[plugin:${pluginName}]`;
  return {
    debug(message: string): void {
      console.debug(prefix, message);
    },
    info(message: string): void {
      console.info(prefix, message);
    },
    warn(message: string): void {
      console.warn(prefix, message);
    },
    error(message: string): void {
      console.error(prefix, message);
    },
  };
}
