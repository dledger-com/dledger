// Plugin system public API
export type {
  Plugin,
  TransactionHandlerExtension,
  HandlerHints,
  PdfParserExtension,
  RateSourceExtension,
  PluginHandlerContext,
} from "./types.js";

export { IndexedHandlerRegistry } from "./indexed-handler-registry.js";
export { PdfParserRegistry, type PdfParserDetectionResult } from "./pdf-parser-registry.js";
export { CexAdapterRegistry } from "./cex-adapter-registry.js";
export { RateSourceRegistry } from "./rate-source-registry.js";
export { PluginManager, getPluginManager, resetPluginManager } from "./manager.js";
