import { HandlerRegistry } from "./registry.js";
import { GenericEtherscanHandler } from "./generic-etherscan.js";
import { pendleHandler } from "./pendle.js";

export { HandlerRegistry } from "./registry.js";
export { syncEtherscanWithHandlers, dryRunReprocess, applyReprocess } from "./pipeline.js";
export type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  HandlerEntry,
} from "./types.js";
export type { ReprocessOptions, ReprocessResult, ReprocessChange } from "./pipeline.js";

export function getDefaultRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.register(GenericEtherscanHandler);
  registry.register(pendleHandler);
  return registry;
}
