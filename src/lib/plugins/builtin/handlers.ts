import type { TransactionHandlerExtension } from "../types.js";
import { GenericEtherscanHandler } from "../../handlers/generic-etherscan.js";
import { pendleHandler } from "../../handlers/pendle.js";
import { uniswapHandler } from "../../handlers/uniswap.js";
import { aaveHandler } from "../../handlers/aave.js";
import { lidoHandler } from "../../handlers/lido.js";
import { dexAggregatorHandler } from "../../handlers/dex-aggregator.js";
import { compoundHandler } from "../../handlers/compound.js";
import { curveHandler } from "../../handlers/curve.js";
import { bridgeHandler } from "../../handlers/bridge.js";
import { yearnHandler } from "../../handlers/yearn.js";
import { balancerHandler } from "../../handlers/balancer.js";
import { makerHandler } from "../../handlers/maker.js";
import { eigenLayerHandler } from "../../handlers/eigenlayer.js";
import {
  UNISWAP,
  AAVE,
  LIDO,
  AGGREGATORS,
  COMPOUND,
  CURVE,
  BRIDGES,
  YEARN,
  BALANCER,
  MAKER,
  EIGENLAYER,
} from "../../handlers/addresses.js";

// Pendle addresses (not exported from addresses.ts — inlined from pendle.ts)
const PENDLE_ROUTER_V4 = "0x888888888889758f76e7103c6cbf23abbf58f946";
const PENDLE_LIMIT_ROUTER = "0x000000000000c9b3e2c3ec88b1b4c0cd853f4321";

export const builtinHandlerExtensions: TransactionHandlerExtension[] = [
  // Generic — universal (no hints), always a candidate
  {
    handler: GenericEtherscanHandler,
    // no hints = universal
  },

  // Uniswap
  {
    handler: uniswapHandler,
    hints: {
      addresses: [
        UNISWAP.V2_ROUTER,
        UNISWAP.V3_ROUTER,
        UNISWAP.V3_ROUTER_2,
        UNISWAP.UNIVERSAL_ROUTER,
        UNISWAP.V4_UNIVERSAL_ROUTER,
        UNISWAP.POSITION_MANAGER_V3,
      ],
      tokenSymbols: ["UNI-V2"],
    },
  },

  // Aave
  {
    handler: aaveHandler,
    hints: {
      addresses: [
        AAVE.V2_POOL,
        AAVE.WRAPPED_TOKEN_GATEWAY,
        AAVE.SWAP_COLLATERAL_ADAPTER,
        ...Object.values(AAVE.CHAIN_POOLS).flat(),
      ],
      tokenPatterns: [
        /^a(?:Eth|Arb|Opt|Pol|Bas)/,
        /^(?:variable|stable)Debt/,
      ],
    },
  },

  // Lido
  {
    handler: lidoHandler,
    hints: {
      addresses: [
        LIDO.STETH,
        LIDO.WITHDRAWAL_QUEUE,
        ...Object.values(LIDO.WSTETH_BY_CHAIN),
      ],
      tokenSymbols: ["STETH", "WSTETH"],
    },
  },

  // Pendle
  {
    handler: pendleHandler,
    hints: {
      addresses: [PENDLE_ROUTER_V4, PENDLE_LIMIT_ROUTER],
      tokenSymbols: ["PENDLE-LPT"],
      tokenPatterns: [/^PT-/, /^YT-/, /^SY-/],
    },
  },

  // DEX Aggregators
  {
    handler: dexAggregatorHandler,
    hints: {
      addresses: [AGGREGATORS.ZEROX_PROXY, AGGREGATORS.COW_PROTOCOL],
      addressPrefixes: [AGGREGATORS.ONEINCH_PREFIX],
    },
  },

  // Compound
  {
    handler: compoundHandler,
    hints: {
      addresses: [
        COMPOUND.COMPTROLLER,
        COMPOUND.C_ETH,
        ...COMPOUND.V2_CTOKENS,
        ...Object.values(COMPOUND.V3_COMETS).flat(),
      ],
      tokenPatterns: [/^c[A-Z]/],
    },
  },

  // Curve
  {
    handler: curveHandler,
    hints: {
      addresses: [CURVE.ROUTER_NG, CURVE.CRV_TOKEN, CURVE.CRV_MINTER],
      tokenSymbols: ["CRV"],
      tokenPatterns: [/^crv/i, /^gauge/i],
    },
  },

  // Bridge
  {
    handler: bridgeHandler,
    hints: {
      addresses: [
        ...Object.values(BRIDGES.ACROSS_SPOKE_POOLS),
        ...BRIDGES.STARGATE_POOLS_ETH,
      ],
    },
  },

  // Yearn
  {
    handler: yearnHandler,
    hints: {
      addresses: [YEARN.V2_REGISTRY, YEARN.V3_REGISTRY],
      tokenPatterns: [/^yv/],
    },
  },

  // Balancer
  {
    handler: balancerHandler,
    hints: {
      addresses: [BALANCER.VAULT, BALANCER.GAUGE_CONTROLLER, BALANCER.BAL_TOKEN],
      tokenSymbols: ["BAL"],
      tokenPatterns: [/^B-/],
    },
  },

  // Maker
  {
    handler: makerHandler,
    hints: {
      addresses: [MAKER.SDAI, MAKER.SPARK_POOL, MAKER.SPARK_GATEWAY],
      tokenSymbols: ["SDAI"],
      tokenPatterns: [/^sp[A-Z]/],
    },
  },

  // EigenLayer
  {
    handler: eigenLayerHandler,
    hints: {
      addresses: [
        EIGENLAYER.STRATEGY_MANAGER,
        EIGENLAYER.DELEGATION_MANAGER,
        EIGENLAYER.EIGENPOD_MANAGER,
        EIGENLAYER.EIGEN_TOKEN,
      ],
      tokenSymbols: ["EIGEN"],
    },
  },
];
