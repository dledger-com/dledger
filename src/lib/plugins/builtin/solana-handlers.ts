import type { SolanaHandlerExtension } from "../types.js";
import { genericSolanaHandler } from "../../solana/handlers/generic-solana.js";
import { jupiterHandler } from "../../solana/handlers/jupiter.js";
import { nativeStakingHandler } from "../../solana/handlers/native-staking.js";
import { raydiumHandler } from "../../solana/handlers/raydium.js";
import { marinadeHandler } from "../../solana/handlers/marinade.js";
import { jitoHandler } from "../../solana/handlers/jito.js";

// Well-known Solana program IDs
const JUPITER_PROGRAM = "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P3LsyLph8";

export const builtinSolanaHandlerExtensions: SolanaHandlerExtension[] = [
  // Generic handler (universal fallback, no program IDs)
  { handler: genericSolanaHandler },
  // Jupiter DEX aggregator
  { handler: jupiterHandler, programIds: [JUPITER_PROGRAM] },
  // Native staking
  { handler: nativeStakingHandler, programIds: [STAKE_PROGRAM] },
  // Raydium AMM/CLMM
  { handler: raydiumHandler, programIds: [RAYDIUM_AMM_V4, RAYDIUM_CLMM] },
  // Marinade liquid staking
  { handler: marinadeHandler, programIds: [MARINADE_PROGRAM] },
  // Jito liquid staking
  { handler: jitoHandler, programIds: [JITO_STAKE_POOL] },
];
