// Centralized contract address constants for DeFi protocol handlers.
// All addresses lowercase.

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const UNISWAP = {
  V2_ROUTER: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
  V3_ROUTER: "0xe592427a0aece92de3edee1f18e0157c05861564",
  V3_ROUTER_2: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  UNIVERSAL_ROUTER: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
  V4_UNIVERSAL_ROUTER: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  POSITION_MANAGER_V3: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
} as const;

const UNISWAP_ALL_ROUTERS: Set<string> = new Set([
  UNISWAP.V2_ROUTER,
  UNISWAP.V3_ROUTER,
  UNISWAP.V3_ROUTER_2,
  UNISWAP.UNIVERSAL_ROUTER,
  UNISWAP.V4_UNIVERSAL_ROUTER,
  UNISWAP.POSITION_MANAGER_V3,
]);

export function isUniswapRouter(addr: string): boolean {
  return UNISWAP_ALL_ROUTERS.has(addr.toLowerCase());
}

export const AAVE = {
  V2_POOL: "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
  WRAPPED_TOKEN_GATEWAY: "0xd322a49006fc828f9b5b37ab215f99b4e5cab19c",
  SWAP_COLLATERAL_ADAPTER: "0xadc0a53095a0af87f3aa29fe0715b5c28016364e",
  CHAIN_POOLS: {
    1: ["0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9", "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"],
    42161: ["0x794a61358d6845594f94dc1db02a252b5b4814ad"],
    10: ["0x794a61358d6845594f94dc1db02a252b5b4814ad"],
    8453: ["0xa238dd80c259a72e81d7e4664a9801593f98d1c5"],
    137: ["0x794a61358d6845594f94dc1db02a252b5b4814ad"],
  } as Record<number, string[]>,
} as const;

export function isAavePool(addr: string, chainId: number): boolean {
  const pools = AAVE.CHAIN_POOLS[chainId];
  if (!pools) return false;
  return pools.includes(addr.toLowerCase());
}

export const LIDO = {
  STETH: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  WSTETH_BY_CHAIN: {
    1: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    42161: "0x5979d7b546e38e414f7e9822514be443a4800529",
    10: "0x1f32b1c2345538c0c6f582fcb022739c4a194ebb",
    8453: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
  } as Record<number, string>,
  WITHDRAWAL_QUEUE: "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1",
} as const;

export function isLidoContract(addr: string, chainId: number): boolean {
  const lower = addr.toLowerCase();
  if (lower === LIDO.STETH) return true;
  if (lower === LIDO.WITHDRAWAL_QUEUE) return true;
  const wsteth = LIDO.WSTETH_BY_CHAIN[chainId];
  if (wsteth && lower === wsteth) return true;
  return false;
}

export const AGGREGATORS = {
  ONEINCH_PREFIX: "0x111111",
  ZEROX_PROXY: "0xdef1c0ded9bec7f1a1670819833240f027b25eff",
  COW_PROTOCOL: "0x9008d19f58aabd9ed0d60971565aa8510560ab41",
} as const;

export function isAggregator(addr: string): "1inch" | "0x" | "cow" | null {
  const lower = addr.toLowerCase();
  if (lower.startsWith(AGGREGATORS.ONEINCH_PREFIX)) return "1inch";
  if (lower === AGGREGATORS.ZEROX_PROXY) return "0x";
  if (lower === AGGREGATORS.COW_PROTOCOL) return "cow";
  return null;
}

export const COMPOUND = {
  COMPTROLLER: "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
  C_ETH: "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5",
  V2_CTOKENS: [
    "0x39aa39c021dfbae8fac545936693ac917d5e7563", // cUSDC
    "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643", // cDAI
    "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5", // cETH
  ],
  V3_COMETS: {
    1: ["0xc3d688b66703497daa19211eedff47f25384cdc3"],
    42161: ["0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf"],
  } as Record<number, string[]>,
} as const;

export function isCompoundContract(addr: string, chainId: number): boolean {
  const lower = addr.toLowerCase();
  if (lower === COMPOUND.COMPTROLLER) return true;
  if ((COMPOUND.V2_CTOKENS as readonly string[]).includes(lower)) return true;
  const comets = COMPOUND.V3_COMETS[chainId];
  if (comets && comets.includes(lower)) return true;
  return false;
}

export const CURVE = {
  ROUTER_NG: "0x16c6521dff6bab339122a0fe25a9116693265353",
  CRV_TOKEN: "0xd533a949740bb3306d119cc777fa900ba034cd52",
  CRV_MINTER: "0xd061d61a4d941c39e5453435b6345dc261c2fce0",
} as const;

export const BRIDGES = {
  ACROSS_SPOKE_POOLS: {
    1: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5",
    42161: "0xb88690461ddbab6f04dfad7df66b7725942feb9c",
    10: "0xa420b2d1c0841415a695b81e5b867bcd07dff8c9",
    8453: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
  } as Record<number, string>,
  STARGATE_POOLS_ETH: [
    "0x77b2043768d28e9c9ab44e1abfc95944bce57931",
    "0xc026395860db2d07ee33e05fe50ed7bd583189c7",
    "0x933597a323eb81cae705c5bc29985172fd5a3973",
  ],
} as const;

export function isBridgeContract(addr: string, chainId: number): "across" | "stargate" | null {
  const lower = addr.toLowerCase();
  const acrossSpokePool = BRIDGES.ACROSS_SPOKE_POOLS[chainId];
  if (acrossSpokePool && lower === acrossSpokePool) return "across";
  if ((BRIDGES.STARGATE_POOLS_ETH as readonly string[]).includes(lower)) return "stargate";
  return null;
}

export const YEARN = {
  V2_REGISTRY: "0x50c1a2ea0a861a967d9d0ffe2ae4012c2e053804",
  V3_REGISTRY: "0xff31a1b020c868f6ea3f61eb953344920eeca3af",
} as const;

const YEARN_ALL_CONTRACTS: Set<string> = new Set([
  YEARN.V2_REGISTRY,
  YEARN.V3_REGISTRY,
]);

export function isYearnContract(addr: string): boolean {
  return YEARN_ALL_CONTRACTS.has(addr.toLowerCase());
}

export const BALANCER = {
  VAULT: "0xba12222222228d8ba445958a75a0704d566bf2c8",
  GAUGE_CONTROLLER: "0xc128468b7ce63ea702c1f104d55a2566b13d3abd",
  BAL_TOKEN: "0xba100000625a3754423978a60c9317c58a424e3d",
} as const;

const BALANCER_ALL_CONTRACTS: Set<string> = new Set([
  BALANCER.VAULT,
  BALANCER.GAUGE_CONTROLLER,
]);

export function isBalancerContract(addr: string): boolean {
  return BALANCER_ALL_CONTRACTS.has(addr.toLowerCase());
}

export const MAKER = {
  SDAI: "0x83f20f44975d03b1b09e64809b757c47f942beea",
  SPARK_POOL: "0xc13e21b648a5ee794902342038ff3adab66be987",
  SPARK_GATEWAY: "0xbd7d6a9ad7865463de44b05f04559f65e3b11704",
} as const;

const MAKER_ALL_CONTRACTS: Set<string> = new Set([
  MAKER.SDAI,
  MAKER.SPARK_POOL,
  MAKER.SPARK_GATEWAY,
]);

export function isMakerContract(addr: string): boolean {
  return MAKER_ALL_CONTRACTS.has(addr.toLowerCase());
}

export const EIGENLAYER = {
  STRATEGY_MANAGER: "0x858646372cc42e1a627fce94aa7a7033e7cf075a",
  DELEGATION_MANAGER: "0x39053d51b77dc0d36036fc1fcc8cb819df8ef37a",
  EIGEN_TOKEN: "0xec53bf9167f50cdeb3ae105f56099aaab9061f83",
  EIGENPOD_MANAGER: "0x91e677b07f7af907ec9a428aafa9fc14a0d3a338",
} as const;

const EIGENLAYER_ALL_CONTRACTS: Set<string> = new Set([
  EIGENLAYER.STRATEGY_MANAGER,
  EIGENLAYER.DELEGATION_MANAGER,
  EIGENLAYER.EIGENPOD_MANAGER,
]);

export function isEigenLayerContract(addr: string): boolean {
  return EIGENLAYER_ALL_CONTRACTS.has(addr.toLowerCase());
}
