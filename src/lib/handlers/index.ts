import { HandlerRegistry } from "./registry.js";
import { GenericEtherscanHandler } from "./generic-etherscan.js";
import { pendleHandler } from "./pendle.js";
import { uniswapHandler } from "./uniswap.js";
import { aaveHandler } from "./aave.js";
import { lidoHandler } from "./lido.js";
import { dexAggregatorHandler } from "./dex-aggregator.js";
import { compoundHandler } from "./compound.js";
import { curveHandler } from "./curve.js";
import { bridgeHandler } from "./bridge.js";
import { yearnHandler } from "./yearn.js";
import { balancerHandler } from "./balancer.js";
import { makerHandler } from "./maker.js";
import { eigenLayerHandler } from "./eigenlayer.js";

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
  registry.register(uniswapHandler);
  registry.register(aaveHandler);
  registry.register(lidoHandler);
  registry.register(dexAggregatorHandler);
  registry.register(compoundHandler);
  registry.register(curveHandler);
  registry.register(bridgeHandler);
  registry.register(yearnHandler);
  registry.register(balancerHandler);
  registry.register(makerHandler);
  registry.register(eigenLayerHandler);
  return registry;
}
