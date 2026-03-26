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
import { convexHandler } from "../../handlers/convex.js";
import { auraHandler } from "../../handlers/aura.js";
import { veAmmHandler } from "../../handlers/ve-amm.js";
import { morphoHandler } from "../../handlers/morpho.js";
import { liquityHandler } from "../../handlers/liquity.js";
import { liquidStakingHandler } from "../../handlers/liquid-staking.js";
import { vaultAggregatorHandler } from "../../handlers/vault-aggregator.js";
import { rewardClaimHandler } from "../../handlers/reward-claim.js";
import { eulerHandler } from "../../handlers/euler.js";
import { gmxHandler } from "../../handlers/gmx.js";
import { originHandler } from "../../handlers/origin.js";
import { notionalHandler } from "../../handlers/notional.js";
import { synthetixHandler } from "../../handlers/synthetix.js";
import { dydxBridgeHandler } from "../../handlers/dydx-bridge.js";
import {
  UNISWAP,
  UNISWAP_FORKS,
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
  CONVEX,
  AURA,
  VE_AMM,
  MORPHO,
  LIQUITY,
  LIQUID_STAKING,
  VAULT_AGGREGATORS,
  REWARD_CLAIMS,
  EULER,
  RADIANT,
  GMX,
  ORIGIN,
  NOTIONAL,
  SYNTHETIX,
  DYDX,
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

  // Uniswap (+ SushiSwap, QuickSwap, PancakeSwap, Camelot forks)
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
        ...Object.values(UNISWAP_FORKS).flatMap((f) => f.routers),
      ],
      tokenSymbols: ["UNI-V2", ...Object.values(UNISWAP_FORKS).map((f) => f.lpSymbol)],
    },
  },

  // Aave (+ Radiant)
  {
    handler: aaveHandler,
    hints: {
      addresses: [
        AAVE.V2_POOL,
        AAVE.WRAPPED_TOKEN_GATEWAY,
        AAVE.SWAP_COLLATERAL_ADAPTER,
        ...Object.values(AAVE.CHAIN_POOLS).flat(),
        RADIANT.V2_POOL_ARBITRUM,
        RADIANT.V2_POOL_BSC,
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

  // DEX Aggregators (1inch, 0x, CoW, Paraswap, Odos, OpenOcean, Firebird)
  {
    handler: dexAggregatorHandler,
    hints: {
      addresses: [
        AGGREGATORS.ZEROX_PROXY,
        AGGREGATORS.COW_PROTOCOL,
        AGGREGATORS.PARASWAP,
        AGGREGATORS.PARASWAP_V6,
        AGGREGATORS.ODOS_ROUTER,
        AGGREGATORS.OPENOCEAN,
        AGGREGATORS.FIREBIRD,
      ],
      addressPrefixes: [AGGREGATORS.ONEINCH_PREFIX],
    },
  },

  // Compound (+ Venus on BSC)
  {
    handler: compoundHandler,
    hints: {
      addresses: [
        COMPOUND.COMPTROLLER,
        COMPOUND.C_ETH,
        ...COMPOUND.V2_CTOKENS,
        ...Object.values(COMPOUND.V3_COMETS).flat(),
        COMPOUND.VENUS_COMPTROLLER,
        COMPOUND.VENUS_VBNB,
        ...COMPOUND.V2_VTOKENS_BSC,
      ],
      tokenPatterns: [/^c[A-Z]/, /^v[A-Z]/],
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

  // Bridge (Across, Stargate, Hop, Circle CCTP)
  {
    handler: bridgeHandler,
    hints: {
      addresses: [
        ...Object.values(BRIDGES.ACROSS_SPOKE_POOLS),
        ...BRIDGES.STARGATE_POOLS_ETH,
        ...Object.values(BRIDGES.STARGATE_V2_POOLS).flat(),
        ...Object.values(BRIDGES.HOP_BRIDGES).flat(),
        ...Object.values(BRIDGES.CCTP_TOKEN_MESSENGER),
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

  // Convex (score 60 — wins over Curve's 55)
  {
    handler: convexHandler,
    hints: {
      addresses: [CONVEX.BOOSTER, CONVEX.CVX_REWARD_POOL],
      tokenSymbols: ["CVX", "cvxCRV"],
      tokenPatterns: [/^cvx/],
    },
  },

  // Aura (score 60 — wins over Balancer's 55)
  {
    handler: auraHandler,
    hints: {
      addresses: [AURA.BOOSTER],
      tokenSymbols: ["AURA", "auraBAL"],
      tokenPatterns: [/^aura/],
    },
  },

  // ve-AMM (Aerodrome on Base, Velodrome on Optimism)
  {
    handler: veAmmHandler,
    hints: {
      addresses: [VE_AMM.AERODROME_ROUTER, VE_AMM.VELODROME_ROUTER],
      tokenSymbols: ["AERO", "VELO"],
    },
  },

  // Morpho
  {
    handler: morphoHandler,
    hints: {
      addresses: [MORPHO.BLUE, MORPHO.BUNDLER_V2],
    },
  },

  // Liquity
  {
    handler: liquityHandler,
    hints: {
      addresses: [
        LIQUITY.BORROWER_OPERATIONS,
        LIQUITY.TROVE_MANAGER,
        LIQUITY.STABILITY_POOL,
        LIQUITY.LQTY_STAKING,
      ],
      tokenSymbols: ["LUSD", "LQTY"],
    },
  },

  // Liquid Staking (Rocket Pool, ether.fi, Kelp, Renzo, Swell, StakeWise, Frax Ether, Ethena)
  {
    handler: liquidStakingHandler,
    hints: {
      addresses: Object.values(LIQUID_STAKING).flatMap((p) =>
        Object.values(p.contracts).flat() as string[],
      ),
      tokenSymbols: Object.values(LIQUID_STAKING).flatMap((p) =>
        p.tokens as unknown as string[],
      ),
    },
  },

  // Vault Aggregator (Beefy, Harvest, Sommelier, Badger — score 53)
  {
    handler: vaultAggregatorHandler,
    hints: {
      addresses: [
        VAULT_AGGREGATORS.HARVEST_CONTROLLER,
        VAULT_AGGREGATORS.SOMMELIER_REGISTRY,
        VAULT_AGGREGATORS.BADGER_SETT_VAULT,
      ],
      tokenPatterns: [/^moo/, /^bv[A-Z]/],
    },
  },

  // Reward Claim (Merkl, Votium — score 52)
  {
    handler: rewardClaimHandler,
    hints: {
      addresses: [
        REWARD_CLAIMS.MERKL_DISTRIBUTOR,
        REWARD_CLAIMS.VOTIUM_MULTI_MERKLE,
      ],
    },
  },

  // Euler V2 (score 55)
  {
    handler: eulerHandler,
    hints: {
      addresses: [EULER.VAULT_CONNECTOR, EULER.E_VAULT_FACTORY],
    },
  },

  // GMX (score 55 — perpetual DEX on Arbitrum/Avalanche)
  {
    handler: gmxHandler,
    hints: {
      addresses: [
        GMX.V2_EXCHANGE_ROUTER,
        GMX.V2_ROUTER,
        GMX.V2_ORDER_HANDLER,
        GMX.V1_ROUTER,
        GMX.V1_VAULT,
        GMX.GLP_MANAGER,
      ],
      tokenSymbols: ["GLP"],
      tokenPatterns: [/^GM[:\-]/],
    },
  },

  // Origin Protocol (score 55 — OUSD/OETH rebasing yield)
  {
    handler: originHandler,
    hints: {
      addresses: [
        ORIGIN.OUSD_VAULT,
        ORIGIN.OETH_VAULT,
        ORIGIN.WOUSD,
        ORIGIN.WOETH,
      ],
      tokenSymbols: ["OUSD", "OETH", "WOUSD", "WOETH"],
    },
  },

  // Notional Finance (score 55 — fixed-rate lending)
  {
    handler: notionalHandler,
    hints: {
      addresses: [NOTIONAL.V3_PROXY],
      tokenPatterns: [/^n[A-Z]/],
    },
  },

  // Synthetix (score 55 — synthetic assets)
  {
    handler: synthetixHandler,
    hints: {
      addresses: [
        SYNTHETIX.V3_CORE_OPTIMISM,
        SYNTHETIX.SNX_TOKEN,
        SYNTHETIX.SUSD,
      ],
      tokenSymbols: ["SNX", "sUSD"],
    },
  },

  // dYdX Bridge (score 50 — bridge + staking)
  {
    handler: dydxBridgeHandler,
    hints: {
      addresses: [
        DYDX.STARKEX_BRIDGE,
        DYDX.DYDX_TOKEN,
        DYDX.SAFETY_MODULE,
      ],
      tokenSymbols: ["DYDX"],
    },
  },
];
