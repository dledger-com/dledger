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

/** Uniswap V2/V3 fork routers keyed by fork ID */
export const UNISWAP_FORKS = {
  sushiswap: {
    name: "SushiSwap",
    routers: [
      "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f", // V2 Router (mainnet)
      "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", // V2 Router (multi-chain)
    ],
    lpSymbol: "SLP",
  },
  quickswap: {
    name: "QuickSwap",
    routers: [
      "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff", // V2 Router (Polygon)
      "0xf5b509bb0909a69b1c207e495f687a596c168e12", // V3 Router (Polygon)
    ],
    lpSymbol: "QUICK-V2",
  },
  pancakeswap: {
    name: "PancakeSwap",
    routers: [
      "0x10ed43c718714eb63d5aa57b78b54704e256024e", // V2 Router (BSC)
      "0x13f4ea83d0bd40e75c8222255bc855a974568dd4", // V3 SmartRouter (BSC)
      "0xeff92a263d31888d860bd49da559bd4f3c2c9c35", // Universal Router (BSC)
    ],
    lpSymbol: "Cake-LP",
  },
  camelot: {
    name: "Camelot",
    routers: [
      "0xc873fecbd354f5a56e00e710b90ef4201db2448d", // V2 Router (Arbitrum)
    ],
    lpSymbol: "CMLT-LP",
  },
} as const;

export type UniswapForkId = keyof typeof UNISWAP_FORKS;

const UNISWAP_ALL_ROUTERS: Set<string> = new Set([
  UNISWAP.V2_ROUTER,
  UNISWAP.V3_ROUTER,
  UNISWAP.V3_ROUTER_2,
  UNISWAP.UNIVERSAL_ROUTER,
  UNISWAP.V4_UNIVERSAL_ROUTER,
  UNISWAP.POSITION_MANAGER_V3,
  ...Object.values(UNISWAP_FORKS).flatMap((f) => f.routers),
]);

export function isUniswapRouter(addr: string): boolean {
  return UNISWAP_ALL_ROUTERS.has(addr.toLowerCase());
}

/** Returns the fork ID if the address belongs to a known Uniswap fork, or null for canonical Uniswap */
export function isUniswapFork(addr: string): UniswapForkId | null {
  const lower = addr.toLowerCase();
  for (const [id, fork] of Object.entries(UNISWAP_FORKS)) {
    if ((fork.routers as readonly string[]).includes(lower)) return id as UniswapForkId;
  }
  return null;
}

/** All fork LP token symbols */
export const UNISWAP_FORK_LP_SYMBOLS: Set<string> = new Set(
  Object.values(UNISWAP_FORKS).map((f) => f.lpSymbol),
);

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
  PARASWAP: "0xdef171fe48cf0115b1d80b88dc8eab59176fee57",
  PARASWAP_V6: "0x6a000f20005980200259b80c5102003040001068",
  ODOS_ROUTER: "0xcf5540fffcdc3d510b18bfca6d2b9987b0772559",
  OPENOCEAN: "0x6352a56caadc4f1e25cd6c75970fa768a3304e64",
  FIREBIRD: "0xe0c38b2a8d09aad53f1c67734b9a95e43d5981c0",
} as const;

export type AggregatorId = "1inch" | "0x" | "cow" | "paraswap" | "odos" | "openocean" | "firebird";

export function isAggregator(addr: string): AggregatorId | null {
  const lower = addr.toLowerCase();
  if (lower.startsWith(AGGREGATORS.ONEINCH_PREFIX)) return "1inch";
  if (lower === AGGREGATORS.ZEROX_PROXY) return "0x";
  if (lower === AGGREGATORS.COW_PROTOCOL) return "cow";
  if (lower === AGGREGATORS.PARASWAP || lower === AGGREGATORS.PARASWAP_V6) return "paraswap";
  if (lower === AGGREGATORS.ODOS_ROUTER) return "odos";
  if (lower === AGGREGATORS.OPENOCEAN) return "openocean";
  if (lower === AGGREGATORS.FIREBIRD) return "firebird";
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
  // Venus (BSC fork of Compound)
  VENUS_COMPTROLLER: "0xfd36e2c2a6789db23113685031d7f16329158384",
  VENUS_VBNB: "0xa07c5b74c9b40447a954e1466938b865b6bbea36",
  V2_VTOKENS_BSC: [
    "0xeca88125a5adbe82614ffc12d0db554e2e2867c8", // vUSDC
    "0xfd5840cd36d94d7229439859c0112a4185bc0255", // vUSDT
    "0x95c78222b3d6e262426483d42cfa53685a67ab9d", // vBUSD
  ],
} as const;

export function isCompoundContract(addr: string, chainId: number): boolean {
  const lower = addr.toLowerCase();
  if (lower === COMPOUND.COMPTROLLER) return true;
  if ((COMPOUND.V2_CTOKENS as readonly string[]).includes(lower)) return true;
  const comets = COMPOUND.V3_COMETS[chainId];
  if (comets && comets.includes(lower)) return true;
  // Venus (BSC)
  if (chainId === 56) {
    if (lower === COMPOUND.VENUS_COMPTROLLER) return true;
    if (lower === COMPOUND.VENUS_VBNB) return true;
    if ((COMPOUND.V2_VTOKENS_BSC as readonly string[]).includes(lower)) return true;
  }
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
  STARGATE_V2_POOLS: {
    1: ["0xc026395860db2d07ee33e05fe50ed7bd583189c7", "0x77b2043768d28e9c9ab44e1abfc95944bce57931"],
    42161: ["0xe8cdf27acd73a434d661b718e687023b4aabbe21"],
    10: ["0x19cfce47ed54a88614648dc3f19a5980097007dd"],
    8453: ["0x27a16dc786820b16e5c9028b75b99f6f604b5d26"],
  } as Record<number, string[]>,
  HOP_BRIDGES: {
    1: [
      "0xb8901acb165ed027e32754e0ffe830802919727f", // ETH Bridge
      "0x3666f603cc164936c1b87e207f36beba4ac5f18a", // USDC Bridge
      "0x3e4a3a4796d16c0cd582c382691998f7c06420b6", // USDT Bridge
      "0x22b1cbb8d98a01a3b71d034bb899775a76eb1cc2", // DAI Bridge
    ],
    42161: ["0x3749c4f034022c39ecaffaba182555d4508caccc"],
    10: ["0x86ca30bef97fb651b8d866d45503684b90cb3312"],
    137: ["0x553bc791d746767166fa3888432038193ccf04e7"],
    100: ["0x25d8039bb044dc227f741a9e381ca4ceae2e6ae8"],
  } as Record<number, string[]>,
  CCTP_TOKEN_MESSENGER: {
    1: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
    42161: "0x19330d10d9cc8751218eaf51e8885d058642e08a",
    10: "0x2b4069517957735be00cee0fadae88a26365528f",
    8453: "0x1682ae6375c4e4a97e4b583bc394c861a46d8962",
    43114: "0x6b25532e1060ce10cc3b0a99e5683b91bfde6982",
    137: "0x9daf8c91aefae50b9c0e69629d3f6ca40ca3b3fe",
  } as Record<number, string>,
} as const;

export type BridgeId = "across" | "stargate" | "hop" | "cctp";

export function isBridgeContract(addr: string, chainId: number): BridgeId | null {
  const lower = addr.toLowerCase();
  const acrossSpokePool = BRIDGES.ACROSS_SPOKE_POOLS[chainId];
  if (acrossSpokePool && lower === acrossSpokePool) return "across";
  if ((BRIDGES.STARGATE_POOLS_ETH as readonly string[]).includes(lower)) return "stargate";
  const stargateV2 = BRIDGES.STARGATE_V2_POOLS[chainId];
  if (stargateV2 && stargateV2.includes(lower)) return "stargate";
  const hopBridges = BRIDGES.HOP_BRIDGES[chainId];
  if (hopBridges && hopBridges.includes(lower)) return "hop";
  const cctpMessenger = BRIDGES.CCTP_TOKEN_MESSENGER[chainId];
  if (cctpMessenger && lower === cctpMessenger) return "cctp";
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

export const MORPHO = {
  BLUE: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  BUNDLER_V2: "0x4095f064b8d3c3548a3beffd0c3d592a7346bf1a",
} as const;

export function isMorphoContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === MORPHO.BLUE || lower === MORPHO.BUNDLER_V2;
}

export const CONVEX = {
  BOOSTER: "0xf403c135812408bfbe8713b5a23a04b3d48aae31",
  CVX_TOKEN: "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b",
  CVX_CRV: "0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7",
  CVX_REWARD_POOL: "0xcf50b810e57ac33b91a927fd0a3331b687d6b7d0",
} as const;

const CONVEX_ALL_CONTRACTS: Set<string> = new Set([CONVEX.BOOSTER, CONVEX.CVX_REWARD_POOL]);

export function isConvexContract(addr: string): boolean {
  return CONVEX_ALL_CONTRACTS.has(addr.toLowerCase());
}

export const AURA = {
  BOOSTER: "0xa57b8d98dae62b26ec3bcc4a365338157060b234",
  AURA_TOKEN: "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
  AURA_BAL: "0x616e8bfa43f920657b3497dbf40d6b1a02d4608d",
} as const;

const AURA_ALL_CONTRACTS: Set<string> = new Set([AURA.BOOSTER]);

export function isAuraContract(addr: string): boolean {
  return AURA_ALL_CONTRACTS.has(addr.toLowerCase());
}

export const VE_AMM = {
  AERODROME_ROUTER: "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43",
  VELODROME_ROUTER: "0xa062ae8a9c5e11aaa026fc2670b0d65ccc8b2858",
} as const;

export function isVeAmmRouter(addr: string): "aerodrome" | "velodrome" | null {
  const lower = addr.toLowerCase();
  if (lower === VE_AMM.AERODROME_ROUTER) return "aerodrome";
  if (lower === VE_AMM.VELODROME_ROUTER) return "velodrome";
  return null;
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

export const LIQUITY = {
  BORROWER_OPERATIONS: "0x24179cd81c9e782a4096035f7ec97fb8b783e007",
  TROVE_MANAGER: "0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
  STABILITY_POOL: "0x66017d22b0f8556afdd19fc67d1949b071a46579",
  LQTY_STAKING: "0x4f9fbb3f1e99b56e0fe2b400c2a23e7006af2502",
} as const;

const LIQUITY_ALL_CONTRACTS: Set<string> = new Set(Object.values(LIQUITY));

export function isLiquityContract(addr: string): boolean {
  return LIQUITY_ALL_CONTRACTS.has(addr.toLowerCase());
}

export interface LiquidStakingProtocol {
  readonly name: string;
  readonly tokens: readonly string[];
  readonly contracts: Record<number, readonly string[]>;
}

export const LIQUID_STAKING: Record<string, LiquidStakingProtocol> = {
  "rocket-pool": {
    name: "Rocket Pool",
    tokens: ["RETH"],
    contracts: { 1: ["0xae78736cd615f374d3085123a210448e74fc6393"] },
  },
  "ether-fi": {
    name: "ether.fi",
    tokens: ["EETH", "WEETH"],
    contracts: { 1: ["0x35fa164735182de50811e8e2e824cfb9b6118ac2", "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee"] },
  },
  "kelp": {
    name: "Kelp",
    tokens: ["RSETH"],
    contracts: { 1: ["0xa1290d69c65a6fe4df752f95823fae25cb99e5a7"] },
  },
  "renzo": {
    name: "Renzo",
    tokens: ["EZETH"],
    contracts: { 1: ["0xbf5495efe5db9ce00f80364c8b423567e58d2110"] },
  },
  "swell": {
    name: "Swell",
    tokens: ["SWETH", "RSWETH"],
    contracts: { 1: ["0xf951e335afb289353dc249e82926178eac7ded78"] },
  },
  "stakewise": {
    name: "StakeWise",
    tokens: ["OSETH"],
    contracts: { 1: ["0xf1c9acdc66974dfb6decb12aa385b9cd01190e38"] },
  },
  "frax-ether": {
    name: "Frax Ether",
    tokens: ["SFRXETH", "FRXETH"],
    contracts: { 1: ["0xac3e018457b222d93114458476f3e3416abbe38f", "0x5e8422345238f34275888049021821e8e08caa1f"] },
  },
  "ethena": {
    name: "Ethena",
    tokens: ["SUSDE", "USDE"],
    contracts: { 1: ["0x9d39a5de30e57443bff2a8307a4256c8797a3497"] },
  },
} as const;

export const VAULT_AGGREGATORS = {
  BEEFY_VAULT_FACTORY: "0x0000000000000000000000000000000000000000", // Beefy has no single factory; match by token pattern
  HARVEST_CONTROLLER: "0x3cc47874dc50d98425ec79e647d83495637c55e3",
  SOMMELIER_REGISTRY: "0x37e3687e410e5c0b79958e5af18e4113865fe1f7",
  BADGER_SETT_VAULT: "0x19d97d8fa813ee2f51ad4b4e04ea08baf4dffc28",
} as const;

export const REWARD_CLAIMS = {
  MERKL_DISTRIBUTOR: "0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae",
  VOTIUM_MULTI_MERKLE: "0x378ba9b73309be80bf4c2c027aad799766a7ed5a",
} as const;

export function isRewardClaimContract(addr: string): "merkl" | "votium" | null {
  const lower = addr.toLowerCase();
  if (lower === REWARD_CLAIMS.MERKL_DISTRIBUTOR) return "merkl";
  if (lower === REWARD_CLAIMS.VOTIUM_MULTI_MERKLE) return "votium";
  return null;
}

export const EULER = {
  VAULT_CONNECTOR: "0x7c68c7866a64fa2160f78eeae12217ffbf871fa8",  // EVC
  E_VAULT_FACTORY: "0x29a56a1b8ab8a55d9eba55e05f7ef04aa7f42297",
} as const;

export function isEulerContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === EULER.VAULT_CONNECTOR || lower === EULER.E_VAULT_FACTORY;
}

export const RADIANT = {
  V2_POOL_ARBITRUM: "0xf4b1486dd74d07706052a33d31d7c0aafd0659e1",
  V2_POOL_BSC: "0xd50cf00b6e600dd036ba8ef475677d816d6c4281",
} as const;

const RADIANT_ALL_POOLS: Set<string> = new Set([
  RADIANT.V2_POOL_ARBITRUM,
  RADIANT.V2_POOL_BSC,
]);

export function isRadiantPool(addr: string): boolean {
  return RADIANT_ALL_POOLS.has(addr.toLowerCase());
}

export function isLiquidStakingToken(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  for (const [id, protocol] of Object.entries(LIQUID_STAKING)) {
    if ((protocol.tokens as unknown as string[]).includes(upper)) return id;
  }
  return null;
}

export function isLiquidStakingContract(addr: string): string | null {
  const lower = addr.toLowerCase();
  for (const [id, protocol] of Object.entries(LIQUID_STAKING)) {
    for (const contracts of Object.values(protocol.contracts)) {
      if ((contracts as unknown as string[]).includes(lower)) return id;
    }
  }
  return null;
}

export const GMX = {
  V2_EXCHANGE_ROUTER: "0x69c527fc77291722b52649e45c838e41be8bf5d5",
  V2_ROUTER: "0x7c68c7866a64fa2160f78eeae12217ffbf871fa8",
  V2_ORDER_HANDLER: "0x352f684ab9e97a6321a13cf03a61316b681d9fd2",
  V1_ROUTER: "0xabc0001f7b44db24e78e22b8b6ded2507d0be211",
  V1_VAULT: "0x489ee077994b6658eafa855c308275ead8097c4a",
  GLP_MANAGER: "0x3963ffc9dff443c2a94f21b129d429891e32ec18",
} as const;

export function isGmxContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === GMX.V2_EXCHANGE_ROUTER || lower === GMX.V2_ROUTER || lower === GMX.V2_ORDER_HANDLER
    || lower === GMX.V1_ROUTER || lower === GMX.V1_VAULT || lower === GMX.GLP_MANAGER;
}

export const ORIGIN = {
  OUSD_VAULT: "0xe75d77b1865ae93c7eaa3040b038d7aa7bc02f70",
  OETH_VAULT: "0x39254033945aa2e4809cc2977e7087bee48bd7ab",
  WOUSD: "0xd2af830e8cbdfed6cc11bab697bb25496ed6fa62",
  WOETH: "0xdcee70654261af21c44c093c300ed3bb97b78192",
} as const;

export function isOriginContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === ORIGIN.OUSD_VAULT || lower === ORIGIN.OETH_VAULT
    || lower === ORIGIN.WOUSD || lower === ORIGIN.WOETH;
}

export const NOTIONAL = {
  V3_PROXY: "0x1344a36a1b56144c3bc62e7757377d288fde0369",
} as const;

export function isNotionalContract(addr: string): boolean {
  return addr.toLowerCase() === NOTIONAL.V3_PROXY;
}

export const SYNTHETIX = {
  V3_CORE_OPTIMISM: "0xffffffaeff0b96ea8e4f94b2253f31abdd875847",
  SNX_TOKEN: "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
  SUSD: "0x57ab1ec28d129707052df4df418d58a2d46d5f51",
} as const;

export function isSynthetixContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === SYNTHETIX.V3_CORE_OPTIMISM || lower === SYNTHETIX.SNX_TOKEN || lower === SYNTHETIX.SUSD;
}

export const DYDX = {
  STARKEX_BRIDGE: "0xd54f502e184b6b739d7d27a6410a67dc462d2c8b",
  DYDX_TOKEN: "0x92d6c1e31e14520e676a687f0a93788b716beff5",
  SAFETY_MODULE: "0x65f7ba4ec257af7c55fd5854e5f6356bbd0fb8ec",
} as const;

export function isDydxContract(addr: string): boolean {
  const lower = addr.toLowerCase();
  return lower === DYDX.STARKEX_BRIDGE || lower === DYDX.DYDX_TOKEN || lower === DYDX.SAFETY_MODULE;
}
